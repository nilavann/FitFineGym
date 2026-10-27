// The one way to declare an Edge Function (template method). It fixes the order every function
// had to repeat by hand: service client, then requireCaller at the function's level, then the
// request body read and checked against its schema, and only then the handler. A function can't
// skip the access check or touch an unvalidated body, because the handler is never reached
// without them. Errors thrown by the handler end in http.ts' handle(), as before.
import { type Caller, type Level, requireCaller } from './auth.ts';
import { type Client, serviceClient } from './clients.ts';
import { readJsonObject, serve } from './http.ts';
import { parseBody, type Rule } from './validate.ts';

/** What a body reader returns: the data the schema checks, and any uploaded files. */
export interface RequestBody {
  data: unknown;
  files?: Record<string, File>;
}

/** Reads the request into a RequestBody. The default reads a JSON object (no files). */
export type BodyReader = (req: Request) => Promise<RequestBody>;

const readJson: BodyReader = async (req) => ({ data: await readJsonObject(req) });

export interface FunctionContext<Body> {
  req: Request;
  /** Service role: bypasses RLS. Reach it only through an entity's repository. */
  admin: Client;
  caller: Caller;
  /** The request DTO: validated, normalized and typed by the schema. */
  body: Body;
  /** Uploaded files, already read within the reader's size limit; empty for a JSON function. */
  files: Record<string, File>;
}

export interface FunctionSpec<Body> {
  /** The deployed function name; also the prefix of its logged errors. */
  name: string;
  /** The least access the caller needs (a 401 / 403 otherwise). */
  level: Level;
  schema: Rule<Body>;
  /** How the request body is read; a JSON object when left out. It runs after the access check. */
  reader?: BodyReader;
}

export function defineFunction<Body>(
  spec: FunctionSpec<Body>,
  handler: (ctx: FunctionContext<Body>) => Promise<Response>,
): void {
  const read = spec.reader ?? readJson;
  serve(spec.name, async (req) => {
    const admin = serviceClient();
    const caller = await requireCaller(req, spec.level, admin);
    const { data, files = {} } = await read(req);
    const body = parseBody(spec.schema, data);
    return await handler({ req, admin, caller, body, files });
  });
}
