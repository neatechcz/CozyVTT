import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';

const socketClientMock = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSocket: vi.fn(),
  startHeartbeat: vi.fn(),
}));

vi.mock('@/services/socket', () => ({ default: socketClientMock }));
vi.mock('@/services/api', () => ({ default: { pingSession: vi.fn() } }));

import { WebSocketProvider, useWebSocket } from '../WebSocketContext';
import ConnectionStatus from '@/components/ConnectionStatus';

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function createSocket() {
  const socket = Object.assign(new FakeEmitter(), { io: new FakeEmitter() });
  return socket as unknown as Socket;
}

function ConnectionProbe({ onRefresh }: { onRefresh: () => void }) {
  const { status, reconnectCount } = useWebSocket();

  useEffect(() => {
    if (reconnectCount > 0) onRefresh();
  }, [onRefresh, reconnectCount]);

  return (
    <>
      <div data-testid="connection-status">{status}</div>
      <div data-testid="reconnect-count">{reconnectCount}</div>
      <ConnectionStatus />
    </>
  );
}

function renderCampaign(socketOrSockets: Socket | Socket[], onRefresh: () => void) {
  const sockets = Array.isArray(socketOrSockets) ? socketOrSockets : [socketOrSockets];
  socketClientMock.connect.mockResolvedValue(undefined);
  sockets.forEach((socket) => socketClientMock.getSocket.mockReturnValueOnce(socket));
  socketClientMock.getSocket.mockReturnValue(sockets[sockets.length - 1]);
  socketClientMock.startHeartbeat.mockReturnValue(vi.fn());

  return render(
    <MemoryRouter
      initialEntries={['/campaign/c1']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route
          path="/campaign/:id"
          element={
            <WebSocketProvider>
              <ConnectionProbe onRefresh={onRefresh} />
            </WebSocketProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('WebSocketProvider automatic reconnection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('restores connection state and refreshes campaign data once after an automatic reconnect', async () => {
    const socket = createSocket();
    const socketEvents = socket as unknown as FakeEmitter;
    const manager = socket.io as unknown as FakeEmitter;
    const onRefresh = vi.fn();
    const { unmount } = renderCampaign(socket, onRefresh);

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
    });
    expect(screen.getByTestId('reconnect-count')).toHaveTextContent('0');
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => socket.emit('disconnect', 'transport close'));
    expect(screen.getByTestId('connection-status')).toHaveTextContent('disconnected');

    act(() => manager.emit('reconnect_attempt', 1));
    expect(screen.getByTestId('connection-status')).toHaveTextContent('connecting');

    act(() => {
      socket.emit('connect');
      manager.emit('reconnect', 1);
    });
    expect(screen.getByTestId('connection-status')).toHaveTextContent('connecting');
    expect(screen.getByTestId('reconnect-count')).toHaveTextContent('0');
    expect(onRefresh).not.toHaveBeenCalled();

    // The Socket.IO transport reconnects before the backend campaign
    // authentication handshake completes. Consumers should refresh only once
    // the server confirms that the campaign socket is authenticated.
    act(() => socket.emit('authenticated', { campaignId: 'c1' }));

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
      expect(screen.getByTestId('reconnect-count')).toHaveTextContent('1');
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(socketEvents.listenerCount('disconnect')).toBe(0);
    expect(socketEvents.listenerCount('connect')).toBe(0);
    expect(socketEvents.listenerCount('authenticated')).toBe(0);
    expect(socketEvents.listenerCount('error')).toBe(0);
    expect(manager.listenerCount('reconnect_attempt')).toBe(0);
    expect(manager.listenerCount('reconnect')).toBe(0);
    expect(manager.listenerCount('reconnect_failed')).toBe(0);
  });

  it('shows an actionable error and allows manual retry when campaign authentication fails after transport reconnect', async () => {
    const socket = createSocket();
    const retrySocket = createSocket();
    const manager = socket.io as unknown as FakeEmitter;
    const onRefresh = vi.fn();
    renderCampaign([socket, retrySocket], onRefresh);

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
    });

    act(() => socket.emit('disconnect', 'transport close'));
    act(() => manager.emit('reconnect_attempt', 1));
    act(() => {
      socket.emit('connect');
      manager.emit('reconnect', 1);
    });
    expect(screen.getByTestId('connection-status')).toHaveTextContent('connecting');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    act(() => socket.emit('error', { message: 'Campaign membership is required' }));
    expect(screen.getByTestId('connection-status')).toHaveTextContent('error');
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute(
      'title',
      'Campaign membership is required'
    );
    expect(screen.getByTestId('reconnect-count')).toHaveTextContent('0');
    expect(onRefresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
      expect(screen.getByTestId('reconnect-count')).toHaveTextContent('1');
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    expect(socketClientMock.connect).toHaveBeenCalledTimes(2);
  });

  it('shows Retry when the Manager exhausts automatic reconnect attempts', async () => {
    const socket = createSocket();
    const manager = socket.io as unknown as FakeEmitter;
    renderCampaign(socket, vi.fn());

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
    });

    act(() => socket.emit('disconnect', 'transport close'));
    act(() => manager.emit('reconnect_failed'));

    expect(screen.getByTestId('connection-status')).toHaveTextContent('error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('still refreshes campaign state when a socket error is followed by successful authentication', async () => {
    const socket = createSocket();
    const manager = socket.io as unknown as FakeEmitter;
    const onRefresh = vi.fn();
    renderCampaign(socket, onRefresh);

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
    });

    act(() => socket.emit('disconnect', 'transport close'));
    act(() => manager.emit('reconnect_attempt', 1));
    act(() => {
      socket.emit('connect');
      manager.emit('reconnect', 1);
    });
    act(() => socket.emit('error', { message: 'A campaign action was rejected' }));

    expect(screen.getByTestId('connection-status')).toHaveTextContent('error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByTestId('reconnect-count')).toHaveTextContent('0');
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => socket.emit('authenticated', { campaignId: 'c1' }));

    await waitFor(() => {
      expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
      expect(screen.getByTestId('reconnect-count')).toHaveTextContent('1');
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
