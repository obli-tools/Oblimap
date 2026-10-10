import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
        // One entry per problem, including nested paths ("permissions.0.level")
        // that the flattened fieldErrors above cannot express.
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    req[source] = result.data;
    next();
  };
}
