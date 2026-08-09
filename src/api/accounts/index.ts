import { Hono } from "hono";
import { registerListRoutes } from "./listroutes";
import { registerByokRoutes } from "./byokroutes";
import { registerAlibabaRoutes } from "./alibabaroutes";
import { registerGitlabDuoRoutes } from "./gitlabduoroutes";
import { registerCrudRoutes } from "./crudroutes";
import { registerActionRoutes } from "./actionroutes";

/**
 * Accounts API — composed from focused route modules.
 * Registration order matters: static paths before /:id.
 */
export const accountsRouter = new Hono();

registerListRoutes(accountsRouter);
registerByokRoutes(accountsRouter);
registerAlibabaRoutes(accountsRouter);
registerGitlabDuoRoutes(accountsRouter);
registerCrudRoutes(accountsRouter);
registerActionRoutes(accountsRouter);

// Public helpers used by OAuth / automation (not HTTP routes).
export { createGitlabDuoAccount } from "./gitlab-helpers";
export type { CreateGitlabDuoInput, CreateGitlabDuoOk, CreateGitlabDuoErr } from "./gitlab-helpers";
export {
  decodeJwtPayload,
  importCodexAccessToken,
  exchangeCodexAuthorizationCode,
  exchangeCodexRefreshTokens,
  extractCodexSessionEntries,
  importCodexSessions,
} from "./actionroutes";
export type { CodexSessionEntry } from "./actionroutes";
