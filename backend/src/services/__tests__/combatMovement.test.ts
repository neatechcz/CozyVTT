import {
  planCombatMovement,
  resolveDnd5eMovementSize,
  resolveDnd5eMovementSpeed,
  type CombatMovementInput,
  type MovementToken,
} from '../combatMovement';

const pcData = (overrides: Record<string, unknown> = {}) => ({
  speed: 30,
  conditions: [],
  survival: { exhaustionLevel: 0 },
  ...overrides,
});

function makeToken(overrides: Partial<MovementToken> = {}): MovementToken {
  return {
    id: 'mover',
    position: { x: 1, y: 1 },
    size: { width: 1, height: 1 },
    disposition: 'friendly',
    conditions: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<CombatMovementInput> = {}): CombatMovementInput {
  return {
    tokenId: 'mover',
    actor: { kind: 'pc', characterData: pcData() },
    destination: { x: 2, y: 1 },
    map: {
      width: 6,
      height: 6,
      gridSize: 50,
      feetPerSquare: 5,
      diagonalRule: 'flat',
      wallSegments: [],
      tokens: [makeToken()],
    },
    ledger: {
      turnId: 'turn-1',
      tokenId: 'mover',
      spentFeet: 0,
      dashBonusFeet: 0,
      diagonalStepsTaken: 0,
    },
    activeTurn: { turnId: 'turn-1', tokenId: 'mover' },
    ...overrides,
  };
}

const verticalWall = (xInSquares: number, type: 'wall' | 'door-closed' | 'door-open' | 'door-locked' | 'window' = 'wall') => ({
  id: `wall-${xInSquares}`,
  x1: xInSquares * 50,
  y1: 0,
  x2: xInSquares * 50,
  y2: 300,
  type,
});

describe('resolveDnd5eMovementSpeed', () => {
  it('resolves a player speed and the PC exhaustion level from the linked sheet', () => {
    expect(resolveDnd5eMovementSpeed({
      kind: 'pc',
      characterData: pcData({ speed: 30, survival: { exhaustionLevel: 2 } }),
    })).toMatchObject({ ok: true, speedFeet: 15 });
  });

  it('halves a 25-foot speed to 12.5 feet under exhaustion level 2', () => {
    expect(resolveDnd5eMovementSpeed({
      kind: 'pc',
      characterData: pcData({ speed: 25, survival: { exhaustionLevel: 2 } }),
    })).toMatchObject({ ok: true, speedFeet: 12.5 });
  });

  it('parses walking speed from an NPC stat block', () => {
    expect(resolveDnd5eMovementSpeed({
      kind: 'npc',
      statBlock: { speed: 'walk 30 ft., fly 60 ft.' },
      conditions: [],
    })).toMatchObject({ ok: true, speedFeet: 30 });
  });

  it('sets speed to zero while restrained or grappled', () => {
    expect(resolveDnd5eMovementSpeed({
      kind: 'npc',
      statBlock: { speed: '30 ft.' },
      conditions: ['Restrained'],
    })).toMatchObject({ ok: true, speedFeet: 0 });
    expect(resolveDnd5eMovementSpeed({
      kind: 'npc',
      statBlock: { speed: '30 ft.' },
      conditions: ['Grappled'],
    })).toMatchObject({ ok: true, speedFeet: 0 });
  });

  it('uses conditions stored on the linked PC sheet', () => {
    expect(resolveDnd5eMovementSpeed({
      kind: 'pc', characterData: pcData({ conditions: ['Restrained'] }),
    })).toMatchObject({ ok: true, speedFeet: 0 });
  });

  it('sets speed to zero while paralyzed, petrified, stunned, or unconscious', () => {
    for (const condition of ['Paralyzed', 'Petrified', 'Stunned', 'Unconscious']) {
      expect(resolveDnd5eMovementSpeed({
        kind: 'npc', statBlock: { speed: '30 ft.' }, conditions: [condition],
      })).toMatchObject({ ok: true, speedFeet: 0 });
    }
  });

  it('fails closed when speed is absent or exhaustion level is ambiguous', () => {
    expect(resolveDnd5eMovementSpeed({ kind: 'pc', characterData: { conditions: [] } }))
      .toMatchObject({ ok: false, error: { code: 'UNRESOLVED_SPEED' } });
    expect(resolveDnd5eMovementSpeed({
      kind: 'npc',
      statBlock: { speed: '30 ft.' },
      conditions: ['Exhausted'],
    })).toMatchObject({ ok: false, error: { code: 'UNRESOLVED_EXHAUSTION_LEVEL' } });
  });

  it('fails closed for prone until the caller supplies a movement mode', () => {
    expect(resolveDnd5eMovementSpeed({
      kind: 'pc',
      characterData: pcData({ conditions: ['Prone'] }),
    })).toMatchObject({ ok: false, error: { code: 'MOVEMENT_MODE_REQUIRED' } });
  });
});

describe('resolveDnd5eMovementSize', () => {
  it('uses the NPC stat block size when present', () => {
    expect(resolveDnd5eMovementSize({
      statBlock: { creatureType: 'Large beast' },
      footprint: { width: 2, height: 2 },
    })).toMatchObject({ ok: true, minimum: 'large', maximum: 'large' });
  });

  it('keeps a one-square footprint uncertain instead of assuming Medium', () => {
    expect(resolveDnd5eMovementSize({ footprint: { width: 1, height: 1 } }))
      .toMatchObject({ ok: true, minimum: 'tiny', maximum: 'medium' });
  });

  it('returns a typed error when the footprint cannot determine a size range', () => {
    expect(resolveDnd5eMovementSize({ footprint: { width: 1, height: 2 } }))
      .toMatchObject({ ok: false, error: { code: 'UNRESOLVED_SIZE' } });
  });
});

describe('planCombatMovement', () => {
  it('adds current speed as Dash allowance and accounts for earlier movement this turn', () => {
    const result = planCombatMovement(makeInput({
      ledger: {
        turnId: 'turn-1', tokenId: 'mover', spentFeet: 25,
        dashBonusFeet: 30, diagonalStepsTaken: 0,
      },
    }));
    expect(result).toMatchObject({
      ok: true,
      movementCostFeet: 5,
      movementSpentFeet: 30,
      remainingMovementFeet: 30,
    });
  });

  it('rejects a legal route whose cost exceeds the remaining turn allowance', () => {
    const route = [2, 3, 4, 5, 6, 7].map((x) => ({ x, y: 1 }));
    expect(planCombatMovement(makeInput({
      destination: { x: 7, y: 1 },
      route,
      map: {
        width: 8, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [], tokens: [makeToken()],
        difficultTerrain: [{ x: 4, y: 1 }],
      },
    }))).toMatchObject({ ok: false, error: { code: 'INSUFFICIENT_MOVEMENT' } });
  });

  it('accepts fractional Dash allowance from halved speed', () => {
    const route = [2, 3, 4, 5, 6].map((x) => ({ x, y: 1 }));
    const result = planCombatMovement(makeInput({
      actor: { kind: 'pc', characterData: pcData({ speed: 25, survival: { exhaustionLevel: 2 } }) },
      destination: { x: 6, y: 1 },
      route,
      map: {
        width: 7, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [], tokens: [makeToken()],
      },
      ledger: {
        turnId: 'turn-1', tokenId: 'mover', spentFeet: 0,
        dashBonusFeet: 12.5, diagonalStepsTaken: 0,
      },
    }));
    expect(result).toMatchObject({ ok: true, speedFeet: 12.5, movementCostFeet: 25, remainingMovementFeet: 0 });
  });

  it('rejects a ledger from a different initiative turn', () => {
    const result = planCombatMovement(makeInput({
      ledger: {
        turnId: 'old-turn', tokenId: 'mover', spentFeet: 0,
        dashBonusFeet: 0, diagonalStepsTaken: 0,
      },
    }));
    expect(result).toMatchObject({ ok: false, error: { code: 'TURN_MISMATCH' } });
  });

  it('carries alternating diagonal parity across split moves', () => {
    const result = planCombatMovement(makeInput({
      destination: { x: 2, y: 2 },
      route: [{ x: 2, y: 2 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'alternating', wallSegments: [], tokens: [makeToken()],
      },
      ledger: {
        turnId: 'turn-1', tokenId: 'mover', spentFeet: 5,
        dashBonusFeet: 0, diagonalStepsTaken: 1,
      },
    }));
    expect(result).toMatchObject({
      ok: true, movementCostFeet: 10, movementSpentFeet: 15,
      diagonalStepsTaken: 2,
    });
  });

  it('scales alternating diagonal costs with the map square size', () => {
    const input = makeInput({
      destination: { x: 2, y: 2 },
      route: [{ x: 2, y: 2 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 10,
        diagonalRule: 'alternating', wallSegments: [], tokens: [makeToken()],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: true, movementCostFeet: 10 });
    expect(planCombatMovement({
      ...input,
      ledger: { ...input.ledger, diagonalStepsTaken: 1 },
    })).toMatchObject({ ok: true, movementCostFeet: 20 });
  });

  it('rejects a route through a wall, while an open door is traversable', () => {
    const base = makeInput({
      destination: { x: 3, y: 1 },
      route: [{ x: 2, y: 1 }, { x: 3, y: 1 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [verticalWall(2)], tokens: [makeToken()],
      },
    });
    expect(planCombatMovement(base)).toMatchObject({ ok: false, error: { code: 'WALL_BLOCKED' } });
    expect(planCombatMovement({
      ...base,
      map: { ...base.map, wallSegments: [verticalWall(2, 'door-open')] },
    })).toMatchObject({ ok: true, destination: { x: 3, y: 1 } });
  });

  it('validates every cell of a multi-square footprint against bounds', () => {
    const input = makeInput({
      destination: { x: 5, y: 1 },
      route: [{ x: 5, y: 1 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [],
        tokens: [makeToken({ size: { width: 2, height: 2 } })],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: false, error: { code: 'OUT_OF_BOUNDS' } });
  });

  it('checks walls against every square in a multi-square footprint', () => {
    const input = makeInput({
      destination: { x: 2, y: 1 },
      route: [{ x: 2, y: 1 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [verticalWall(3)],
        tokens: [makeToken({ size: { width: 2, height: 1 } })],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: false, error: { code: 'WALL_BLOCKED' } });
  });

  it('allows nonhostile pass-through at difficult-terrain cost but never ends in that space', () => {
    const input = makeInput({
      destination: { x: 3, y: 1 },
      route: [{ x: 2, y: 1 }, { x: 3, y: 1 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [],
        difficultTerrain: [],
        tokens: [makeToken(), makeToken({
          id: 'ally', position: { x: 2, y: 1 }, disposition: 'friendly',
          sizeCategory: 'medium',
        })],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: true, movementCostFeet: 15 });
    expect(planCombatMovement({ ...input, destination: { x: 2, y: 1 }, route: [{ x: 2, y: 1 }] }))
      .toMatchObject({ ok: false, error: { code: 'OCCUPIED_DESTINATION' } });
  });

  it('rejects passage through an equally sized hostile creature', () => {
    const input = makeInput({
      destination: { x: 3, y: 1 },
      route: [{ x: 2, y: 1 }, { x: 3, y: 1 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [],
        tokens: [makeToken({ sizeCategory: 'medium' }), makeToken({
          id: 'enemy', position: { x: 2, y: 1 }, disposition: 'hostile',
          sizeCategory: 'medium',
        })],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: false, error: { code: 'HOSTILE_OCCUPANT' } });
  });

  it('treats object tokens as solid obstacles even when marked friendly', () => {
    const input = makeInput({
      destination: { x: 3, y: 1 },
      route: [{ x: 2, y: 1 }, { x: 3, y: 1 }],
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [],
        tokens: [makeToken(), makeToken({
          id: 'crate', position: { x: 2, y: 1 }, type: 'object', disposition: 'friendly',
        })],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: false, error: { code: 'OBJECT_BLOCKED' } });
  });

  it('allows hostile pass-through only when the size difference is certainly at least two', () => {
    const hugeToken = makeToken({
      id: 'huge-enemy', position: { x: 2, y: 1 },
      size: { width: 3, height: 3 }, disposition: 'hostile',
      sizeCategory: undefined,
      statBlock: { creatureType: 'Huge giant' },
    });
    const passHuge = makeInput({
      actor: { kind: 'pc', characterData: pcData({ speed: 40 }) },
      destination: { x: 5, y: 1 },
      route: [{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 }],
      map: {
        width: 7, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [], tokens: [makeToken(), hugeToken],
      },
    });
    expect(planCombatMovement(passHuge)).toMatchObject({ ok: true, movementCostFeet: 35 });

    const largeToken = { ...hugeToken, id: 'large-enemy', size: { width: 2, height: 2 }, statBlock: { creatureType: 'Large beast' } };
    const uncertain = planCombatMovement({
      ...passHuge,
      actor: { kind: 'pc', characterData: pcData({ speed: 40 }) },
      map: { ...passHuge.map, tokens: [makeToken(), largeToken] },
    });
    expect(uncertain).toMatchObject({ ok: false, error: { code: 'UNRESOLVED_SIZE_DIFFERENCE' } });
  });

  it('charges twice the step cost when entering difficult terrain', () => {
    const input = makeInput({
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [], tokens: [makeToken()],
        difficultTerrain: [{ x: 2, y: 1 }],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: true, movementCostFeet: 10 });
  });

  it('finds an automatic shortest legal route and rejects a destination with no path', () => {
    const traversable = makeInput({
      destination: { x: 2, y: 2 }, route: undefined,
    });
    expect(planCombatMovement(traversable)).toMatchObject({
      ok: true, route: [{ x: 2, y: 2 }], movementCostFeet: 5,
    });

    const blocked = makeInput({
      destination: { x: 4, y: 1 }, route: undefined,
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat',
        wallSegments: [verticalWall(2)],
        tokens: [makeToken()],
      },
    });
    expect(planCombatMovement(blocked)).toMatchObject({ ok: false, error: { code: 'NO_PATH' } });
  });

  it('reports an occupied automatic destination directly', () => {
    const input = makeInput({
      destination: { x: 2, y: 1 }, route: undefined,
      map: {
        width: 6, height: 6, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [],
        tokens: [makeToken(), makeToken({ id: 'other', position: { x: 2, y: 1 } })],
      },
    });
    expect(planCombatMovement(input)).toMatchObject({ ok: false, error: { code: 'OCCUPIED_DESTINATION' } });
  });

  it('rejects an explicit route with a nonadjacent step or the wrong endpoint', () => {
    expect(planCombatMovement(makeInput({
      destination: { x: 3, y: 1 }, route: [{ x: 3, y: 1 }],
    }))).toMatchObject({ ok: false, error: { code: 'NON_ADJACENT_STEP' } });
    expect(planCombatMovement(makeInput({
      destination: { x: 3, y: 1 }, route: [{ x: 2, y: 1 }],
    }))).toMatchObject({ ok: false, error: { code: 'ROUTE_DESTINATION_MISMATCH' } });
  });

  it('rejects explicit routes and automatic searches above their resource limits', () => {
    const longRoute = Array.from({ length: 513 }, (_, index) => ({ x: index % 2 === 0 ? 2 : 1, y: 1 }));
    expect(planCombatMovement(makeInput({
      destination: { x: 2, y: 1 }, route: longRoute,
    }))).toMatchObject({ ok: false, error: { code: 'ROUTE_TOO_LONG' } });

    expect(planCombatMovement(makeInput({
      destination: { x: 2, y: 1 }, route: undefined,
      map: {
        width: 400, height: 300, gridSize: 50, feetPerSquare: 5,
        diagonalRule: 'flat', wallSegments: [], tokens: [makeToken()],
      },
    }))).toMatchObject({ ok: false, error: { code: 'PATH_SEARCH_LIMIT' } });
  });
});
