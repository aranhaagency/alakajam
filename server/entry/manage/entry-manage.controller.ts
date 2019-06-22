import cache from "server/core/cache";
import constants from "server/core/constants";
import enums from "server/core/enums";
import fileStorage from "server/core/file-storage";
import forms from "server/core/forms";
import * as models from "server/core/models";
import security from "server/core/security";
import templating from "server/core/templating-functions";
import highscoreService from "server/entry/highscore/entry-highscore.service";
import platformService from "server/entry/platform/platform.service";
import tagService from "server/entry/tag/tag.service";
import eventService from "server/event/event.service";
import eventTournamentService from "server/event/tournament/tournament.service";

export async function entryManage(req, res) {
  const { event, user } = res.locals;
  let entry = res.locals.entry;

  // Security checks
  if (!user) {
    res.redirect("/login?redirect=" + req.url);
    return;
  } else if (!entry && event) {
    const existingEntry = await eventService.findUserEntryForEvent(user, event.id);
    if (existingEntry) {
      // User with an entry went to the creation URL, redirect him
      res.redirect(templating.buildUrl(existingEntry, "entry", "edit"));
      return;
    } else if (!eventService.areSubmissionsAllowed(event)) {
      res.errorPage(403, "Submissions are closed for this event");
      return;
    } else {
      // Creation (in event)
      entry = new models.Entry({
        event_id: res.locals.event.get("id"),
        event_name: res.locals.event.get("name"),
        division: event.get("status_entry") === enums.EVENT.STATUS_ENTRY.OPEN_UNRANKED
          ? enums.DIVISION.UNRANKED : eventService.getDefaultDivision(event),
      });
    }
  } else if (!entry) {
    // Creation (external event)
    entry = new models.Entry({
      division: "solo",
    });
  }

  if (entry.get("id") && !security.canUserWrite(user, entry, { allowMods: true })) {
    res.errorPage(403);
    return;
  }

  const isPlayedInTournament = await eventTournamentService.findActiveTournamentPlaying(entry.get("id"));
  const errorMessages = res.locals.errorMessages || [];

  if (req.method === "POST") {
    // Parse form data
    const isExternalEvent = req.body["external-event"] !== undefined || !event;
    let links = [];
    let i = 0;
    if (req.body["submit-links"]) {
      while (req.body["url" + i] || req.body["label" + i]) {
        const label = forms.sanitizeString(req.body["label" + i]);
        const url = req.body["url" + i];
        links.push({
          label,
          url,
        });
        i++;
      }
    } else {
      // If the client-side JS didn't have the time to load, don't change the links
      links = entry.get("links") || [];
    }

    let platforms = null;
    if (req.body.platforms) {
      // Ensure the requested platforms (if any) are valid before proceeding.
      let platformNames = (Array.isArray(req.body.platforms)) ? req.body.platforms : [req.body.platforms];
      platformNames = platformNames.map(forms.sanitizeString);
      platforms = await platformService.fetchMultipleNamed(platformNames);
      if (platforms.length < platformNames.length) {
        errorMessages.push("One or more platforms are invalid: " + platformNames.join(", "));
      }
    }

    // Create model if needed
    let isCreation;
    if (!entry.get("id")) {
      entry = await eventService.createEntry(user, event);
      isCreation = true;
    } else {
      isCreation = false;
    }

    // Save tags
    let tags = (Array.isArray(req.body.tags)) ? req.body.tags : [req.body.tags];
    tags = tags.map((tag) => forms.sanitizeString(tag));
    await tagService.updateEntryTags(entry, tags);

    // Update entry

    let statusHighScore = "off";
    if (req.body["enable-high-score"] === "on") {
      statusHighScore = req.body["high-score-reversed"]
        ? enums.ENTRY.STATUS_HIGH_SCORE.REVERSED : enums.ENTRY.STATUS_HIGH_SCORE.NORMAL;
    }

    entry.set({
      title: forms.sanitizeString(req.body.title),
      description: forms.sanitizeString(req.body.description),
      links,
      allow_anonymous: req.body["anonymous-enabled"] === "on",
      status_high_score: statusHighScore,
    });

    if (isExternalEvent) {
      entry.set({
        event_id: null,
        event_name: null,
        published_at: forms.parseDateTime(req.body["published-at"]) || null,
        external_event: forms.sanitizeString(req.body["external-event"]),
      });
    }

    if (req.body["picture-delete"]) {
      if (entry.picturePreviews().length > 0) {
        await fileStorage.remove(entry.picturePreviews()[0]);
      }
      if (entry.pictureThumbnail()) {
        await fileStorage.remove(entry.pictureThumbnail());
      }
      if (entry.pictureIcon()) {
        await fileStorage.remove(entry.pictureIcon());
      }
      entry.set("pictures", { previews: [] });
    } else if (req.file && (await fileStorage.isValidPicture(req.file.path))) {
      const result = await eventService.setEntryPicture(entry, req.file);
      if (result.error) {
        errorMessages.push(result.error);
      }
    }

    // Update entry details

    const optouts = [];
    if (req.body["optout-graphics"]) { optouts.push("Graphics"); }
    if (req.body["optout-audio"]) { optouts.push("Audio"); }

    let highScoreType = forms.sanitizeString(req.body["high-score-type"], { maxLength: 20 });
    if (highScoreType === "custom") {
      highScoreType = forms.sanitizeString(req.body["custom-unit"], { maxLength: 20 });
    }

    const entryDetails = entry.related("details");
    entryDetails.set({
      optouts,
      body: forms.sanitizeMarkdown(req.body.body, { maxLength: constants.MAX_BODY_ENTRY_DETAILS }),
      high_score_type: highScoreType,
      high_score_instructions: forms.sanitizeString(req.body["high-score-instructions"], { maxLength: 2000 }),
    });

    // Save entry: Validate form data
    i = 0;
    for (const link of links) {
      i++;
      if (!forms.isURL(link.url)) {
        errorMessages.push(`Link #${i} '${link.label}' is invalid. Url <${link.url}> is not a valid url.`);
      } else if (!link.label) {
        errorMessages.push(`Link #${i} <${link.url}> is invalid. Label is required.`);
      }
    }

    if (isPlayedInTournament && statusHighScore === enums.ENTRY.STATUS_HIGH_SCORE.OFF) {
      errorMessages.push("Cannot disable high scores while the game is featured in an active tournament");
    } else if (!forms.isLengthValid(links, 1000)) {
      errorMessages.push("Too many links (max allowed: around 7)");
    } else if (!entry && !isExternalEvent && !eventService.areSubmissionsAllowed(event)) {
      errorMessages.push("Submissions are closed for this event");
    } else if (req.body.division && !isExternalEvent && event
        && !forms.isIn(req.body.division, Object.keys(event.get("divisions")))) {
      errorMessages.push("Invalid division");
    }

    if (errorMessages.length === 0) {
      // Save entry: Prepare team changes
      let teamMembers = null;
      if (req.body.members) {
        if (!Array.isArray(req.body.members)) {
          req.body.members = [req.body.members];
        }
        teamMembers = req.body.members.map((s) => parseInt(s, 10));
        let ownerId;
        if (!isCreation) {
          ownerId = entry.related("userRoles")
            .findWhere({ permission: constants.PERMISSION_MANAGE })
            .get("user_id");
        } else {
          ownerId = res.locals.user.get("id");
        }
        if (!teamMembers.includes(ownerId)) {
          teamMembers.push(ownerId);
        }
      }

      // Manager-only changes
      if (isCreation || security.canUserManage(user, entry, { allowMods: true })) {
        let division = req.body.division || eventService.getDefaultDivision(event);
        if (event &&
          (event.get("status_entry") === enums.EVENT.STATUS_ENTRY.OPEN_UNRANKED
            || event.get("status_entry") === enums.EVENT.STATUS_ENTRY.CLOSED)) {
          if (!entry.has("division")) {
            // New entries are all unranked
            division = enums.DIVISION.UNRANKED;
          } else {
            // Existing entries cannot change division
            division = entry.get("division");
          }
        }
        entry.set("division", division);

        res.locals.infoMessage = "";
        if (teamMembers !== null) {
          const teamChanges = await eventService.setTeamMembers(user, entry, teamMembers);
          if (teamChanges.numAdded > 0) {
            res.locals.infoMessage += teamChanges.numAdded + " user(s) have been sent an invite to join your team. ";
          }
          if (teamChanges.numRemoved > 0) {
            res.locals.infoMessage += teamChanges.numRemoved + " user(s) have been removed from the team.";
          }
        }
      }

      // Save entry: Persist changes and side effects
      const eventCountRefreshNeeded = event
        && (isCreation || entry.hasChanged("division") || entry.hasChanged("published_at"));
      await entryDetails.save();
      if (entry.hasChanged("status_high_score")
          && entry.get("status_high_score") !== enums.ENTRY.STATUS_HIGH_SCORE.OFF) {
        // corner case: owner toggles lower-is-better after some scores are submitted
        highscoreService.refreshEntryRankings(entry);
      }
      entry.set("published_at", entry.get("published_at") || new Date());
      await entry.save();
      if (eventCountRefreshNeeded) {
        eventService.refreshEventCounts(event); // No need to await
      }

      // Set or remove platforms.
      platformService.setEntryPlatforms(entry, platforms || []);
      cache.user(res.locals.user).del("latestEntry");
      await entry.load(["userRoles.user", "comments", "details", "tags"]);

      // Save entry: Redirect to view upon success
      res.redirect(templating.buildUrl(entry, "entry"));
      return;
    }
  }

  res.render("entry/manage/entry-manage", {
    entry,
    members: await eventService.findTeamMembers(entry, res.locals.user),
    allPlatforms: await platformService.fetchAllNames(),
    entryPlatforms: entry.get("platforms"),
    external: !res.locals.event,
    tags: entry.related("tags").map((tag) => ({ id: tag.id, value: tag.get("value") })),
    isPlayedInTournament,
    errorMessages,
  });
}

/**
 * Deletes an entry
 */
export async function entryDelete(req, res) {
  const { entry, event, user } = res.locals;

  if (user && entry && security.canUserManage(user, entry, { allowMods: true })) {
    await entry.load("posts");
    entry.related("posts").forEach(async (post) => {
      post.set("entry_id", null);
      await post.save();
    });
    await eventService.deleteEntry(entry);
    if (event) {
      eventService.refreshEventCounts(event); // No need to await
    }
    cache.user(res.locals.user).del("latestEntry");
  }

  if (event) {
    res.redirect(templating.buildUrl(event, "event"));
  } else {
    res.redirect(templating.buildUrl(user, "user", "entries"));
  }
}

/**
 * Leaves the team of an entry
 */
export async function entryLeave(req, res) {
  const { entry, user } = res.locals;

  if (user && entry) {
    // Remove requesting user posts from the entry
    await entry.load("posts");
    entry.related("posts").forEach(async (post) => {
      if (post.get("author_user_id") === user.get("id")) {
        post.set("entry_id", null);
        await post.save();
      }
    });

    // Remove requesting user from the team
    const newTeamMembers = [];
    entry.related("userRoles").each((userRole) => {
      if (userRole.get("user_id") !== user.get("id")) {
        newTeamMembers.push(userRole.get("user_id"));
      }
    });
    await eventService.setTeamMembers(user, entry, newTeamMembers);

    cache.user(user).del("latestEntry");
  }

  if (res.locals.event) {
    res.redirect(templating.buildUrl(res.locals.event, "event"));
  } else {
    res.redirect(templating.buildUrl(res.locals.user, "user", "entries"));
  }
}