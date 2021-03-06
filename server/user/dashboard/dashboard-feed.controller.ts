import { BookshelfCollection, BookshelfModel } from "bookshelf";
import cache from "server/core/cache";
import eventService from "server/event/event.service";
import commentService from "server/post/comment/comment.service";
import postService from "server/post/post.service";
import userService from "../user.service";

/**
 * View comment feed
 */
export async function dashboardFeed(req, res) {
  const dashboardUser = res.locals.dashboardUser;

  // if an entry is not in the cache it will return undefined
  const userCache = cache.user(dashboardUser);
  let byUserCollection = userCache.get<BookshelfCollection>("byUserCollection");
  let toUserCollection = userCache.get<BookshelfCollection>("toUserCollection");
  let latestEntry = userCache.get<BookshelfModel>("latestEntry");
  let latestPostsCollection = userCache.get<BookshelfCollection>("latestPostsCollection");

  if (!byUserCollection) {
    byUserCollection = await commentService.findCommentsByUser(dashboardUser);
    userCache.set("byUserCollection", byUserCollection);
  }
  if (!toUserCollection) {
    toUserCollection = await commentService.findCommentsToUser(dashboardUser);
    userCache.set("toUserCollection", toUserCollection);
  }
  if (!latestEntry) {
    latestEntry = await eventService.findLatestUserEntry(dashboardUser);
    userCache.set("latestEntry", latestEntry);
  }
  if (!latestPostsCollection) {
    latestPostsCollection = await postService.findPosts({
      userId: dashboardUser.id,
    });
    userCache.set("latestPostsCollection", latestPostsCollection);
  }
  const invitesCollection = await eventService.findEntryInvitesForUser(dashboardUser, {
    withRelated: ["entry.event", "entry.userRoles", "invited"],
  });

  const notificationsLastRead = dashboardUser.get("notifications_last_read");
  if (!res.locals.dashboardAdminMode) {
    dashboardUser.set("notifications_last_read", new Date());
    await userService.save(dashboardUser);
    userCache.del("unreadNotifications");
    res.locals.unreadNotifications = 0;
  }

  // TODO Limit at the SQL-level
  res.render("user/dashboard/dashboard-feed", {
    byUser: byUserCollection.slice(0, 20),
    toUser: toUserCollection.slice(0, 20),
    latestEntry,
    latestPosts: latestPostsCollection.slice(0, 3),
    invites: invitesCollection.models,
    notificationsLastRead,
  });
}
