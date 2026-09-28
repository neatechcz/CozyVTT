/**
 * Documents written or edited in CozyVTT, as opposed to uploaded.
 *
 * Only plain text and Markdown can be typed. A PDF is a file and stays one.
 *
 * The content is never interpreted by the server. It is checked to be text,
 * bounded in size, written to disk under a generated name, and served back as
 * text/plain. What keeps it harmless is that nothing ever renders it as HTML:
 * the reader uses react-markdown with raw HTML off and unsafe URL schemes
 * stripped, and the serving route sets the content type itself. Stripping
 * characters here would not add safety and would corrupt a rules document that
 * mentions `<tags>` or writes `1 < 2`.
 */

import { z } from 'zod';
import { isPlainTextBuffer } from '../utils/textFile';

/** The two formats a person can type. */
export const TYPED_DOCUMENT_FORMATS = ['txt', 'md'] as const;
export type TypedDocumentFormat = (typeof TYPED_DOCUMENT_FORMATS)[number];

export const TYPED_DOCUMENT_MIME: Record<TypedDocumentFormat, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
};

/**
 * Below the upload limit on purpose. Typed content arrives as JSON, and the
 * body parser stops at 1 MB; this leaves room for the rest of the request. A
 * document larger than this is a file to upload, not a thing to type.
 */
export const MAX_TYPED_DOCUMENT_BYTES = 900 * 1024;

export const MAX_DOCUMENT_NAME_LENGTH = 200;

/**
 * Text as a person would recognise it: valid UTF-8 (which a JSON string
 * already is), no NUL, no control characters beyond whitespace. The same bar an
 * uploaded .txt or .md has to clear.
 */
const typedContent = z
  .string()
  .superRefine((content, ctx) => {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_TYPED_DOCUMENT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `That is too long to save as typed text. Upload it as a file instead.`,
      });
      return;
    }
    if (!isPlainTextBuffer(bytes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The text contains characters that do not belong in a document.',
      });
    }
  });

export const CreateDocumentSchema = z.object({
  name: z.string().trim().min(1, 'A document needs a name').max(MAX_DOCUMENT_NAME_LENGTH),
  description: z.string().trim().max(1000).optional(),
  format: z.enum(TYPED_DOCUMENT_FORMATS),
  content: typedContent,
  scope: z.enum(['USER', 'CAMPAIGN', 'GLOBAL']).default('USER'),
  campaignId: z.string().uuid().optional(),
});

export const UpdateDocumentContentSchema = z.object({
  content: typedContent,
});

export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;
export type UpdateDocumentContentInput = z.infer<typeof UpdateDocumentContentSchema>;
