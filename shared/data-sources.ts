import { z } from 'zod';

// References describe actual inputs, never inferred text matches.
export const dataSourceSchema = z
  .object({
    kind: z.enum(['comments', 'leads', 'inboxThreads', 'notes', 'insights']),
    id: z.string().min(1).max(2000),
  })
  .strict();
export type DataSource = z.infer<typeof dataSourceSchema>;
