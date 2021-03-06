import { CommonLocals } from "server/common.middleware";
import cache from "server/core/cache";
import config from "server/core/config";
import security from "server/core/security";
import { CustomRequest, CustomResponse } from "server/types";

/**
 * Admin only: server status
 */
export async function adminStatus(req: CustomRequest, res: CustomResponse<CommonLocals>) {
  if (!config.DEBUG_ADMIN && !security.isAdmin(res.locals.user)) {
    res.errorPage(403);
  }

  if (req.query.clearCache && cache.cacheMap[req.query.clearCache]) {
    cache.cacheMap[req.query.clearCache].flushAll();
  }

  let pictureResizeEnabled = false;
  try {
    require("sharp");
    pictureResizeEnabled = true;
  } catch (e) {
    // Nothing
  }

  res.render("admin/status/admin-status", {
    devMode: !!res.app.locals.devMode,
    pictureResizeEnabled,
    caches: cache.cacheMap,
  });
}
