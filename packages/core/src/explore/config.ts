import { z } from "zod";

/** Validate public exploration controls before a job is accepted. */
export const ExploreConfigSchema = z.object({
  maxSteps: z.number().int().positive().max(1000).optional(),
  maxStates: z.number().int().positive().max(1000).optional(),
  maxMinutes: z.number().positive().max(120).optional(),
  maxRecoverySteps: z.number().int().nonnegative().max(100).optional(),
  pilotDevice: z.string().optional(),
  allowExternalNavigation: z.boolean().optional(),
  allowedOrigins: z.array(z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
  }, "Use an HTTP(S) origin without a path, credentials, query or fragment")).max(50).optional(),
  allowDestructive: z.boolean().optional(),
  disallowedKeywords: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  testCredentials: z.record(z.string()).optional(),
  perDevice: z.boolean().optional(),
  useMockAgent: z.boolean().optional()
});
