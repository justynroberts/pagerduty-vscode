import type { Server, ServerResponse } from 'node:http';
export function verifySignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean;
export function toRelayEvent(body: unknown): { type: string; incidentId: string | null; at: string } | null;
export function createRelay(opts: { webhookSecret?: string; clientToken?: string; log?: (m: string) => void }): {
  server: Server;
  clients: Set<ServerResponse>;
  broadcast(evt: unknown): void;
};
