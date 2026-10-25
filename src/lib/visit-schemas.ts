/**
 * Zod validation for visit registration and transitions. Pure — no imports
 * beyond zod, so it is unit-testable and safe to import in any layer.
 */
import { z } from 'zod';

export const plateSchema = z
  .string()
  .trim()
  .min(2, 'Plate must be at least 2 characters.')
  .max(20, 'Plate must be at most 20 characters.')
  .regex(
    /^[0-9A-Za-z\u0600-\u06FF\s\-_.]+$/,
    'Plate contains invalid characters.'
  );

export const uuidSchema = z.string().uuid('Must be a valid identifier.');

export const driverNameSchema = z
  .string()
  .trim()
  .min(2, 'Driver name must be at least 2 characters.')
  .max(120, 'Driver name must be at most 120 characters.');

export const companyNameSchema = z
  .string()
  .trim()
  .min(2, 'Company name must be at least 2 characters.')
  .max(160, 'Company name must be at most 160 characters.');

export const notesSchema = z.string().trim().max(2000, 'Notes are too long.').optional();

export const reasonSchema = z
  .string()
  .trim()
  .min(3, 'A reason of at least 3 characters is required for this action.')
  .max(500, 'Reason is too long (max 500 characters).');

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency key is malformed.')
  .max(64, 'Idempotency key is malformed.');

export const registerVisitSchema = z.object({
  plate: plateSchema,
  companyId: uuidSchema,
  newCompanyName: companyNameSchema.optional(),
  driverName: driverNameSchema.optional(),
  driverPhone: z
    .string()
    .trim()
    .max(30, 'Phone is too long.')
    .regex(/^[+0-9\s()\-]*$/, 'Phone contains invalid characters.')
    .optional(),
  notes: notesSchema,
  idempotencyKey: idempotencyKeySchema
});

export type RegisterVisitInput = z.infer<typeof registerVisitSchema>;

export const transitionVisitSchema = z
  .object({
    visitId: uuidSchema,
    target: z.enum([
      'WAITING_FOR_SECURITY',
      'AT_SECURITY',
      'WAITING_FOR_LAB',
      'AT_LAB',
      'COMPLETED',
      'ON_HOLD',
      'REJECTED',
      'CANCELLED'
    ]),
    reason: reasonSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (
      ['ON_HOLD', 'REJECTED', 'CANCELLED'].includes(value.target) &&
      (!value.reason || value.reason.length < 3)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A reason is mandatory for hold/reject/cancel actions.'
      });
    }
  });

export type TransitionVisitInput = z.infer<typeof transitionVisitSchema>;
