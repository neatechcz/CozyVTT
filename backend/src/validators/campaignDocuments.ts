/**
 * Sharing a document with a campaign.
 *
 * Only the id is taken from the request. Whether the document exists, is a
 * document, and may be read by the caller are all decided by the route against
 * the database, never from anything the client says about it.
 */

import { z } from 'zod';

export const LinkDocumentSchema = z.object({
  assetId: z.string().uuid('A document must be named by its asset id'),
});

export type LinkDocumentInput = z.infer<typeof LinkDocumentSchema>;
