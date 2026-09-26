import { io, Socket } from 'socket.io-client';
import type {
  TokenMoveStartEvent,
  TokenMoveEvent,
  TokenMoveEndEvent,
  TokenMovedEvent,
  DiceRollEvent,
  DiceRolledEvent,
  DiceRolledSecretEvent,
  ChatMessageEvent,
  ChatMessageBroadcast,
  SessionStartEvent,
  SessionStartedBroadcast,
  VibeUpdateEvent,
  VibeUpdatedBroadcast,
  SpiritLayerToggleEvent,
  SpiritLayerToggledBroadcast,
  SpiritLayerTokenToggledBroadcast,
  AtmosphereEffectSetEvent,
  AtmosphereEffectUpdatedBroadcast,
  AtmosphereAudioSetEvent,
  AtmosphereAudioUpdatedBroadcast,
  CharacterHpUpdateEvent,
  CharacterHpUpdatedBroadcast,
  CombatState,
  InitiativeAddEvent,
  InitiativeRemoveEvent,
  InitiativeSetEvent,
  InitiativeRollEvent,
  InitiativeReorderEvent,
} from '@/types';
import type { TokenAddedPayload, TokenUpdatedPayload, TokenRemovedPayload } from '@/utils/tokenEvents';

// ============================================
// WebSocket Client Configuration
// ============================================

// Use relative URL in development to leverage Vite's proxy (Docker support)
// Use absolute URL in production
// Empty string = relative URLs (Nginx proxies /socket.io/* to backend in production,
// Vite dev server proxies in development)
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || '';

type EventCallback<T = any> = (data: T) => void;

/**
 * Client-level connection signals (not server events):
 * - `replaced`: a new underlying socket was created (listeners added with
 *   `on()` are already re-attached to it)
 * - `authenticated`: joined the campaign room (first join and every rejoin)
 * - `disconnected`: the connection dropped (socket.io may be retrying)
 * - `failed`: the client gave up — socket.io exhausted its own retries, the
 *   retries after a server-forced disconnect ran out, or a connection timed
 *   out. Nothing reconnects by itself after this; a new `connect()` is needed.
 */
export type SocketLifecycleEvent = 'replaced' | 'authenticated' | 'disconnected' | 'failed';

/** Extra information for a lifecycle signal (`failed`: why, when known). */
export interface SocketLifecycleDetail {
  error?: string;
}

type SocketLifecycleListener = (event: SocketLifecycleEvent, detail?: SocketLifecycleDetail) => void;

const CONNECT_TIMEOUT_MESSAGE = 'Connection timeout - server did not respond';

/** Message of a server `error` event (`{ message }` or a plain string). */
function serverErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  return null;
}

class SocketClient {
  private socket: Socket | null = null;
  /**
   * Retries after server-forced disconnects since the last successful
   * campaign join (or the last connect() made by a caller). A transport-level
   * `connect` does not reset it: the server kicks an unauthenticated
   * connection right after accepting it, which used to restart the count and
   * retry forever.
   */
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  /**
   * Last server `error` message seen while connecting or during a retry
   * series (why the series failed). Domain errors of an established
   * connection (e.g. a rejected token move) are not recorded.
   */
  private lastServerError: string | null = null;
  private reconnectDelay = 1000; // Start with 1 second
  private isConnecting = false;
  private campaignId: string | null = null;
  private quiet = false;
  private lifecycleListeners = new Set<SocketLifecycleListener>();
  /**
   * Every listener added with `on()` (and the `onX()` helpers), by event.
   * The client replaces its underlying socket (server-forced reconnect,
   * browser back online, campaign switch); each new socket gets all of them
   * attached again, so subscribers never go deaf after a replacement.
   */
  private listenerRegistry = new Map<string, Set<EventCallback>>();
  /** Removes this client's own reconnect_* handlers from the current socket's Manager. */
  private reconnectManagerCleanup: (() => void) | null = null;

  constructor() {
    // Socket will be initialized when connect() is called
  }

  private clearReconnectManagerListeners() {
    this.reconnectManagerCleanup?.();
    this.reconnectManagerCleanup = null;
  }

  // ============================================
  // Connection Management
  // ============================================

  /**
   * Connect to a campaign room. `quiet` joins without being announced (no
   * "has joined/left the campaign" chat message, no user.joined/user.left) —
   * for pages outside the campaign view, e.g. the standalone character
   * editor. An existing connection to the same campaign is reused as is.
   */
  connect(campaignId: string, options: { quiet?: boolean } = {}): Promise<void> {
    return this.open(campaignId, options, false);
  }

  /** `retry`: opened by reconnect() — continues its attempt count instead of starting a new series. */
  private open(campaignId: string, options: { quiet?: boolean }, retry: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.connected && this.campaignId === campaignId) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        reject(new Error('Connection already in progress'));
        return;
      }

      const quiet = options.quiet === true;
      if (!retry) {
        this.reconnectAttempts = 0;
        this.lastServerError = null;
      }
      this.isConnecting = true;
      this.campaignId = campaignId;
      this.quiet = quiet;

      // Disconnect and clean up any existing socket first
      if (this.socket) {
        this.clearReconnectManagerListeners();
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      const socket = io(SOCKET_URL, {
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: this.reconnectDelay,
        reconnectionDelayMax: 30000,       // Cap backoff at 30s
        reconnectionAttempts: this.maxReconnectAttempts,
        // Jitter (±50%) so a fleet of clients dropped at the same moment
        // doesn't all hit the server in lockstep — prevents thundering herd
        // after a backend restart or transient hosting hiccup.
        randomizationFactor: 0.5,
      });
      this.socket = socket;
      this.attachRegisteredListeners(socket);
      this.emitLifecycle('replaced');

      // Set up a timeout to prevent hanging forever
      const connectionTimeout = setTimeout(() => {
        // A newer connect() (after disconnect()) owns the client now — leave it alone
        if (this.socket !== socket) {
          reject(new Error('Connection abandoned'));
          return;
        }
        console.error('[Socket] Connection timeout - server did not respond within 10 seconds');
        this.isConnecting = false;
        this.clearReconnectManagerListeners();
        socket.removeAllListeners();
        socket.disconnect();
        this.socket = null;
        reject(new Error(CONNECT_TIMEOUT_MESSAGE));
        // Nothing retries a torn-down socket — e.g. the replacement built by
        // reconnect() after a server-forced disconnect, whose promise no
        // caller awaits. Tell the listeners so they can show the failure.
        this.emitLifecycle('failed', { error: CONNECT_TIMEOUT_MESSAGE });
      }, 10000);

      // Set up authenticated listener FIRST (before any events can fire)
      this.socket.on('authenticated', () => {
        clearTimeout(connectionTimeout);
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.lastServerError = null;
        resolve();
        this.emitLifecycle('authenticated');
      });

      // Backend ready — emit authenticate once we know the server is listening
      this.socket.on('connected', () => {
        if (!this.socket) {
          console.error('[Socket] Socket is null in connected handler');
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          reject(new Error('Socket is null in connected handler'));
          return;
        }

        // Sent again on every (re)connect, with the same quiet flag
        this.socket.emit('authenticate', quiet ? { campaignId, quiet: true } : { campaignId });
      });

      // Connection error
      this.socket.on('connect_error', (error) => {
        console.error('[Socket] Connection error:', error);
        clearTimeout(connectionTimeout);
        this.isConnecting = false;
        reject(error);
      });

      // Disconnected
      this.socket.on('disconnect', (reason) => {
        this.emitLifecycle('disconnected');
        if (reason === 'io server disconnect') {
          // A kick during the handshake ends this attempt: without this the
          // next retry would be refused as "already in progress"
          if (this.socket === socket && this.isConnecting) {
            clearTimeout(connectionTimeout);
            this.isConnecting = false;
            reject(new Error('Disconnected by the server'));
          }
          // Server disconnected us, need to manually reconnect
          this.reconnect(socket);
        }
      });

      // Socket.IO emits retry lifecycle events on the Manager, not the
      // namespace Socket. Keep these handlers scoped so replaced sockets do
      // not leave listeners on their Managers. Only exhaustion matters here:
      // after socket.io's own successful reconnect the backend emits
      // 'connected' and the socket re-authenticates (handler above).
      const manager = socket.io;
      const handleReconnectFailed = () => {
        console.error('[Socket] Reconnection failed after max attempts');
        clearTimeout(connectionTimeout);
        this.isConnecting = false;
        reject(new Error('Failed to reconnect after maximum attempts'));
        // socket.io gave up on this (still current) socket
        if (this.socket === socket) this.emitLifecycle('failed');
      };

      manager.on('reconnect_failed', handleReconnectFailed);

      this.reconnectManagerCleanup = () => {
        manager.off('reconnect_failed', handleReconnectFailed);
      };

      // Error events from server
      this.socket.on('error', (error) => {
        console.error('[Socket] Server error event:', error);
        if (this.isConnecting || this.reconnectAttempts > 0) {
          this.lastServerError = serverErrorMessage(error) ?? this.lastServerError;
        }
        clearTimeout(connectionTimeout);
        this.isConnecting = false;
        reject(error);
      });
    });
  }

  /**
   * Rebuilds the connection after the server disconnected `socket` (socket.io
   * does not retry those). At most `maxReconnectAttempts` retries per series,
   * with exponential backoff; then gives up with the `failed` signal, carrying
   * the server's last error (e.g. "Unauthorized" for an expired session).
   */
  private reconnect(socket: Socket) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Socket] Max reconnection attempts reached');
      // The kicked socket stays in this.socket (disconnected, its Manager
      // closed) until the next connect() or disconnect() replaces it.
      this.emitLifecycle('failed', this.lastServerError ? { error: this.lastServerError } : undefined);
      return;
    }

    // Exponential backoff capped at 30s, plus up to 1s jitter to avoid lockstep retries.
    const backoff = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    const delay = backoff + Math.floor(Math.random() * 1000);
    this.reconnectAttempts++;
    setTimeout(() => {
      // disconnect() or a newer connect() owns the client now
      if (this.socket !== socket || !this.campaignId) return;
      this.open(this.campaignId, { quiet: this.quiet }, true).catch((error) => {
        console.error('[Socket] Reconnection error:', error);
      });
    }, delay);
  }

  disconnect() {
    this.clearReconnectManagerListeners();
    this.reconnectAttempts = 0;
    this.lastServerError = null;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this.campaignId = null;
      this.quiet = false;
    }

    // Reset connection state to allow reconnection
    this.isConnecting = false;
  }

  /** Subscribe to client-level connection signals; returns the unsubscribe. */
  onLifecycle(listener: SocketLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  private emitLifecycle(event: SocketLifecycleEvent, detail?: SocketLifecycleDetail) {
    for (const listener of [...this.lifecycleListeners]) {
      if (detail) listener(event, detail);
      else listener(event);
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Campaign the client is connected (or connecting) to, if any. */
  getCampaignId(): string | null {
    return this.campaignId;
  }

  // ============================================
  // State Synchronization
  // ============================================

  requestSync(lastEventId?: string) {
    if (!this.socket?.connected) {
      return;
    }

    this.socket.emit('sync.request', {
      lastEventId,
    });
  }

  onSyncState(callback: EventCallback) {
    this.on('sync.state', callback);
  }

  // ============================================
  // Token Movement Events
  // ============================================

  emitTokenMoveStart(data: TokenMoveStartEvent) {
    this.socket?.emit('token.move.start', data);
  }

  emitTokenMove(data: TokenMoveEvent) {
    this.socket?.emit('token.move', data);
  }

  emitTokenMoveEnd(data: TokenMoveEndEvent) {
    this.socket?.emit('token.move.end', data);
  }

  onTokenMoved(callback: EventCallback<TokenMovedEvent>) {
    this.on('token.moved', callback);
  }

  // Token add / update / remove made through the REST API (DM or MCP).
  // The server filters per recipient; hidden tokens reach DMs only.

  onTokenAdded(callback: EventCallback<TokenAddedPayload>) {
    this.on('token.added', callback);
  }

  offTokenAdded(callback: EventCallback<TokenAddedPayload>) {
    this.off('token.added', callback);
  }

  onTokenUpdated(callback: EventCallback<TokenUpdatedPayload>) {
    this.on('token.updated', callback);
  }

  offTokenUpdated(callback: EventCallback<TokenUpdatedPayload>) {
    this.off('token.updated', callback);
  }

  onTokenRemoved(callback: EventCallback<TokenRemovedPayload>) {
    this.on('token.removed', callback);
  }

  offTokenRemoved(callback: EventCallback<TokenRemovedPayload>) {
    this.off('token.removed', callback);
  }

  // ============================================
  // Dice Rolling Events
  // ============================================

  emitDiceRoll(data: DiceRollEvent) {
    this.socket?.emit('dice.roll', data);
  }

  onDiceRolled(callback: EventCallback<DiceRolledEvent>) {
    this.on('dice.rolled', callback);
  }

  onDiceRolledSecret(callback: EventCallback<DiceRolledSecretEvent>) {
    this.on('dice.rolled.secret', callback);
  }

  emitClearDiceHistory() {
    this.socket?.emit('dice.clearHistory');
  }

  onDiceHistoryCleared(callback: EventCallback<void>) {
    this.on('dice.historyCleared', callback);
  }

  // ============================================
  // Chat Events
  // ============================================

  emitChatMessage(data: ChatMessageEvent) {
    this.socket?.emit('chat.message', data);
  }

  onChatMessage(callback: EventCallback<ChatMessageBroadcast>) {
    this.on('chat.message', callback);
  }

  onChatSystem(callback: EventCallback<{ content: string; metadata?: any; timestamp: string }>) {
    this.on('chat.system', callback);
  }

  // ============================================
  // Map Events
  // ============================================

  emitMapChange(mapId: string) {
    this.socket?.emit('map.change', { mapId });
  }

  onMapChanged(callback: EventCallback<{ mapId: string; mapData: any }>) {
    this.on('map.changed', callback);
  }

  // ============================================
  // Session Events
  // ============================================

  emitSessionStart(data: SessionStartEvent) {
    this.socket?.emit('session.start', data);
  }

  emitSessionPause() {
    this.socket?.emit('session.pause', {});
  }

  emitSessionEnd(saveState: boolean = true) {
    this.socket?.emit('session.end', { saveState });
  }

  onSessionStarted(callback: EventCallback<SessionStartedBroadcast>) {
    this.on('session.started', callback);
  }

  onSessionPaused(callback: EventCallback) {
    this.on('session.paused', callback);
  }

  onSessionEnded(callback: EventCallback<{ message: string }>) {
    this.on('session.ended', callback);
  }

  onSessionResumed(callback: EventCallback) {
    this.on('session.resumed', callback);
  }

  // ============================================
  // Vibe Tracker Events
  // ============================================

  emitVibeUpdate(data: VibeUpdateEvent) {
    this.socket?.emit('vibe.update', data);
  }

  onVibeUpdated(callback: EventCallback<VibeUpdatedBroadcast>) {
    this.on('vibe.updated', callback);
  }

  // ============================================
  // Spirit Layer Events
  // ============================================

  emitSpiritLayerToggle(data: SpiritLayerToggleEvent) {
    this.socket?.emit('spirit_layer.toggle', data);
  }

  emitSpiritLayerTokenToggle(mapId: string, tokenId: string, visible: boolean) {
    this.socket?.emit('spirit_layer.token.toggle', { mapId, tokenId, visible });
  }

  onSpiritLayerToggled(callback: EventCallback<SpiritLayerToggledBroadcast>) {
    this.on('spirit_layer.toggled', callback);
  }

  onSpiritLayerTokenToggled(callback: EventCallback<SpiritLayerTokenToggledBroadcast>) {
    this.on('spirit_layer.token.toggled', callback);
  }

  emitSpiritLayerStyleChange(style: string) {
    this.socket?.emit('spirit_layer.style_change', { style });
  }

  onSpiritLayerStyleChanged(callback: EventCallback<{ style: string }>) {
    this.on('spirit_layer.style_changed', callback);
  }

  // ============================================
  // Atmosphere Events
  // ============================================

  emitAtmosphereEffectSet(data: AtmosphereEffectSetEvent) {
    this.socket?.emit('atmosphere.effect.set', data);
  }

  onAtmosphereEffectUpdated(callback: EventCallback<AtmosphereEffectUpdatedBroadcast>) {
    this.on('atmosphere.effect.updated', callback);
  }

  emitAtmosphereAudioSet(data: AtmosphereAudioSetEvent) {
    this.socket?.emit('atmosphere.audio.set', data);
  }

  onAtmosphereAudioUpdated(callback: EventCallback<AtmosphereAudioUpdatedBroadcast>) {
    this.on('atmosphere.audio.updated', callback);
  }

  // ============================================
  // Character HP
  // ============================================

  emitCharacterHpUpdate(data: CharacterHpUpdateEvent) {
    this.socket?.emit('character.hp.update', data);
  }

  onCharacterHpUpdated(callback: EventCallback<CharacterHpUpdatedBroadcast>) {
    this.on('character.hp.updated', callback);
  }

  // ============================================
  // Initiative Tracker Events
  // ============================================

  emitInitiativeAdd(data: InitiativeAddEvent) {
    this.socket?.emit('initiative.add', data);
  }

  emitInitiativeRemove(data: InitiativeRemoveEvent) {
    this.socket?.emit('initiative.remove', data);
  }

  emitInitiativeSet(data: InitiativeSetEvent) {
    this.socket?.emit('initiative.set', data);
  }

  emitInitiativeRoll(data: InitiativeRollEvent) {
    this.socket?.emit('initiative.roll', data);
  }

  emitInitiativeReorder(data: InitiativeReorderEvent) {
    this.socket?.emit('initiative.reorder', data);
  }

  emitInitiativeStart() {
    this.socket?.emit('initiative.start');
  }

  emitInitiativeNext() {
    this.socket?.emit('initiative.next');
  }

  emitInitiativeEnd() {
    this.socket?.emit('initiative.end');
  }

  emitInitiativeRequestState() {
    this.socket?.emit('initiative.request_state');
  }

  onInitiativeState(callback: EventCallback<CombatState>) {
    this.on('initiative.state', callback);
  }

  // ============================================
  // Heartbeat
  // ============================================

  startHeartbeat(interval: number = 30000) {
    if (!this.socket) return;

    const heartbeatInterval = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('ping');
      } else {
        clearInterval(heartbeatInterval);
      }
    }, interval);

    this.socket.on('pong', () => {
      // Connection is healthy
    });

    return () => clearInterval(heartbeatInterval);
  }

  // ============================================
  // Event Cleanup
  // ============================================

  /**
   * Adds a listener that stays subscribed across socket replacements (see
   * `listenerRegistry`). Adding the same handler for the same event again is
   * a no-op, so it is never called twice per event.
   */
  on(event: string, callback: EventCallback) {
    let listeners = this.listenerRegistry.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listenerRegistry.set(event, listeners);
    }
    if (listeners.has(callback)) return;
    listeners.add(callback);
    this.socket?.on(event, callback);
  }

  /** Removes the listener (all listeners of the event without a callback) for good. */
  off(event: string, callback?: EventCallback) {
    if (callback) {
      const listeners = this.listenerRegistry.get(event);
      listeners?.delete(callback);
      if (listeners?.size === 0) this.listenerRegistry.delete(event);
      this.socket?.off(event, callback);
    } else {
      // Only the registered listeners — the client's own connection handlers stay
      for (const listener of this.listenerRegistry.get(event) ?? []) this.socket?.off(event, listener);
      this.listenerRegistry.delete(event);
    }
  }

  removeAllListeners() {
    for (const [event, listeners] of this.listenerRegistry) {
      for (const listener of listeners) this.socket?.off(event, listener);
    }
    this.listenerRegistry.clear();
  }

  private attachRegisteredListeners(socket: Socket) {
    for (const [event, listeners] of this.listenerRegistry) {
      for (const listener of listeners) socket.on(event, listener);
    }
  }

  // ============================================
  // Socket Instance Access
  // ============================================

  getSocket(): Socket | null {
    return this.socket;
  }
}

// Export singleton instance
export const socketClient = new SocketClient();
export default socketClient;
