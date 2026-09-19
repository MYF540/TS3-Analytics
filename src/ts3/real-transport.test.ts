import { EventEmitter } from 'node:events';
import { TeamSpeak } from 'ts3-nodejs-library';
import { describe, expect, it, vi } from 'vitest';
import {
  attachNotificationHandlers,
  enterViewToClient,
  type RawEnterView,
} from './real-transport.js';
import type { Ts3TransportEvents } from './types.js';

const enterView: RawEnterView = {
  clid: '12',
  ctid: '5',
  clientDatabaseId: '345',
  clientUniqueIdentifier: 'abcDEF123+/=',
  clientNickname: 'Alice',
  clientType: 0,
  clientAway: false,
  clientInputMuted: true,
  clientOutputMuted: false,
  clientServergroups: ['8', '12'],
  clientPlatform: 'Windows',
  clientVersion: '3.6.2',
  clientCountry: 'DE',
};

describe('enterViewToClient', () => {
  it('maps the join notification', () => {
    expect(enterViewToClient(enterView)).toEqual({
      clid: 12,
      dbid: 345,
      uid: 'abcDEF123+/=',
      nickname: 'Alice',
      type: 0,
      channelId: 5,
      idleMs: 0,
      away: false,
      inputMuted: true,
      outputMuted: false,
      serverGroups: [8, 12],
      platform: 'Windows',
      version: '3.6.2',
      country: 'DE',
    });
  });

  it('tolerates missing optional fields', () => {
    const minimal = enterViewToClient({
      clid: '1',
      ctid: '1',
      clientDatabaseId: '2',
      clientUniqueIdentifier: 'u',
      clientNickname: 'n',
      clientType: 1,
      clientCountry: '',
    });
    expect(minimal).toMatchObject({ serverGroups: [], country: undefined, away: false });
  });
});

describe('attachNotificationHandlers', () => {
  function setup() {
    const teamspeak = new TeamSpeak({ autoConnect: false });
    const query = (teamspeak as unknown as { query: EventEmitter }).query;
    const clientList = vi.spyOn(teamspeak, 'clientList');
    const channelList = vi.spyOn(teamspeak, 'channelList');
    const target = new EventEmitter<Ts3TransportEvents>();
    attachNotificationHandlers(teamspeak, target);
    return { query, clientList, channelList, target };
  }

  it('emits events from notifications without sending extra commands (rule 5)', () => {
    const { query, clientList, channelList, target } = setup();
    const events: unknown[] = [];
    target.on('clientConnect', (c) => events.push(['connect', c.uid, c.channelId]));
    target.on('clientMoved', (e) => events.push(['moved', e.clid, e.channelId]));
    target.on('clientDisconnect', (e) => events.push(['left', e.clid, e.reasonId]));

    query.emit('cliententerview', enterView);
    query.emit('clientmoved', { clid: '12', ctid: '7', reasonid: '0' });
    query.emit('clientleftview', { clid: '12', reasonid: '8', cfid: '7', ctid: '0' });

    expect(events).toEqual([
      ['connect', 'abcDEF123+/=', 5],
      ['moved', 12, 7],
      ['left', 12, 8],
    ]);
    expect(clientList).not.toHaveBeenCalled();
    expect(channelList).not.toHaveBeenCalled();
  });

  it('removes the library handlers for these notifications', () => {
    const { query } = setup();
    expect(query.listenerCount('cliententerview')).toBe(1);
    expect(query.listenerCount('clientleftview')).toBe(1);
    expect(query.listenerCount('clientmoved')).toBe(1);
  });
});
