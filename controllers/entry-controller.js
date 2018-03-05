'use strict'

/**
 * Entry pages
 *
 * @module controllers/entry-controller
 */

const fileStorage = require('../core/file-storage')
const log = require('../core/log')
const forms = require('../core/forms')
const models = require('../core/models')
const eventService = require('../services/event-service')
const eventRatingService = require('../services/event-rating-service')
const postService = require('../services/post-service')
const securityService = require('../services/security-service')
const platformService = require('../services/platform-service')
const settingService = require('../services/setting-service')
const tagService = require('../services/tag-service')
const templating = require('./templating')
const postController = require('./post-controller')
const cache = require('../core/cache')
const constants = require('../core/constants')
const enums = require('../core/enums')

module.exports = {
  entryMiddleware,

  viewEntry,
  editEntry,
  deleteEntry,
  leaveEntry,

  saveCommentOrVote,

  acceptInvite,
  declineInvite,

  searchForTeamMate,
  searchForExternalEvents,
  searchForTags
}

/**
 * Fetches the current entry & event
 */
async function entryMiddleware (req, res, next) {
  let entry = await eventService.findEntryById(req.params.entryId)
  if (!entry) {
    res.errorPage(404, 'Entry not found')
    return
  }
  res.locals.entry = entry
  res.locals.pageTitle = entry.get('title')
  res.locals.pageDescription = entry.get('description') || forms.markdownToText(entry.related('details').get('body'))
  if (entry.get('pictures') && entry.get('pictures').length > 0) {
    res.locals.pageImage = entry.get('pictures')[0]
  }

  if (req.params.eventName !== 'external-entry' &&
      (req.params.eventName !== entry.get('event_name') || req.params.entryName !== entry.get('name'))) {
    res.redirect(templating.buildUrl(entry, 'entry', req.params.rest))
    return
  }

  next()
}

/**
 * Browse entry
 */
async function viewEntry (req, res) {
  const entry = res.locals.entry
  // Let the template display user thumbs
  await entry.load('userRoles.user')

  // Check voting phase
  let eventVote = eventRatingService.areVotesAllowed(res.locals.event)

  // Fetch vote on someone else's entry
  let vote
  let canVote = false
  if (res.locals.user && eventVote &&
      !securityService.canUserWrite(res.locals.user, entry)) {
    canVote = await eventRatingService.canVoteOnEntry(res.locals.user, entry)
    if (canVote) {
      vote = await eventRatingService.findEntryVote(res.locals.user, entry)
    }
  }

  // Count votes
  let entryVotes = await eventRatingService.countEntryVotes(entry)
  let minEntryVotes = null
  if (res.locals.user && securityService.canUserWrite(res.locals.user, entry)) {
    minEntryVotes = parseInt(await settingService.find(constants.SETTING_EVENT_REQUIRED_ENTRY_VOTES, '10'))
  }

  let editableAnonComments = null
  if (res.locals.user && entry.get('allow_anonymous')) {
    editableAnonComments = await postService.findOwnAnonymousCommentIds(res.locals.user, entry.get('id'), 'entry')
  }

  res.render('entry/view-entry', {
    sortedComments: await postService.findCommentsSortedForDisplay(entry),
    editableAnonComments,
    posts: await postService.findPosts({
      entryId: entry.get('id')
    }),
    entryVotes,
    minEntryVotes,
    vote,
    canVote,
    eventVote,
    external: !res.locals.event
  })
}

async function editEntry (req, res) {
  let {entry, event, user} = res.locals

  // Security checks
  if (!user) {
    res.redirect('/login')
    return
  } else if (!entry && event) {
    let existingEntry = await eventService.findUserEntryForEvent(user, event.id)
    if (existingEntry) {
      // User with an entry went to the creation URL, redirect him
      res.redirect(templating.buildUrl(existingEntry, 'entry', 'edit'))
      return
    } else if (!eventService.areSubmissionsAllowed(event)) {
      res.errorPage(403, 'Submissions are closed for this event')
      return
    } else {
      // Creation (in event)
      entry = new models.Entry({
        event_id: res.locals.event.get('id'),
        event_name: res.locals.event.get('name'),
        division: event.get('status_entry') === enums.EVENT.STATUS_ENTRY.OPEN_UNRANKED
          ? enums.DIVISION.UNRANKED : eventService.getDefaultDivision(event)
      })
    }
  } else if (!entry) {
    // Creation (external event)
    entry = new models.Entry({
      division: 'solo'
    })
  }

  if (entry.get('id') && !securityService.canUserWrite(user, entry, { allowMods: true })) {
    res.errorPage(403)
    return
  }

  let errorMessage = null
  if (req.method === 'POST') {
    let {fields, files} = await req.parseForm('picture')

    // Parse form data
    let isExternalEvent = fields['external-event'] !== undefined
    let links = []
    let i = 0
    if (fields['submit-links']) {
      while (fields['url' + i]) {
        let label = forms.sanitizeString(fields['label' + i])
        let url = fields['url' + i]
        if (label === 'other') {
          label = forms.sanitizeString(fields['customlabel' + i])
        }
        links.push({
          label,
          url
        })
        i++
      }
    } else {
      // If the client-side JS didn't have the time to load, don't change the links
      links = entry.get('links') || []
    }

    let platforms = null
    if (fields.platforms) {
      // Ensure the requested platforms (if any) are valid before proceeding.
      let platformNames = (Array.isArray(fields.platforms)) ? fields.platforms : [fields.platforms]
      platformNames = platformNames.map(tag => forms.sanitizeString(tag))
      platforms = await platformService.fetchMultipleNamed(platformNames)
      if (platforms.length < platformNames.length) {
        errorMessage = 'One or more platforms are invalid'
      } else {
        entry.set('platforms', platforms.map(p => p.get('name')))
      }
    }

    // Save entry: Update model (even if validation fails, to prevent losing what the user filled)
    let isCreation
    if (!entry.get('id')) {
      entry = await eventService.createEntry(user, event)
      isCreation = true
    } else {
      isCreation = false
    }

    // Tags
    let tags = (Array.isArray(fields.tags)) ? fields.tags : [fields.tags]
    tags = tags.map(tag => forms.sanitizeString(tag))
    await tagService.updateEntryTags(entry, tags)

    entry.set({
      'title': forms.sanitizeString(fields.title),
      'description': forms.sanitizeString(fields.description),
      'links': links
    })
    if (isExternalEvent) {
      entry.set({
        event_id: null,
        event_name: null,
        external_event: forms.sanitizeString(fields['external-event'])
      })
    }
    let picturePath = '/entry/' + entry.get('id')
    if (fields['picture-delete'] && entry.get('pictures').length > 0) {
      await fileStorage.remove(entry.get('pictures')[0])
      entry.set('pictures', [])
    } else if (files.picture && files.picture.size > 0 && fileStorage.isValidPicture(files.picture.path)) { // TODO Formidable shouldn't create an empty file
      let finalPath = await fileStorage.savePictureUpload(files.picture.path, picturePath)
      entry.set('pictures', [finalPath])
    } else if (fields.picture) {
      entry.set('pictures', [forms.sanitizeString(fields.picture)])
    }

    let entryDetails = entry.related('details')
    entryDetails.set('body', forms.sanitizeMarkdown(fields.body, constants.MAX_BODY_ENTRY_DETAILS))

    // Save entry: Validate form data
    for (let link of links) {
      if (!forms.isURL(link.url) || !link.label) {
        errorMessage = 'Link #' + i + ' is invalid'
        break
      }
    }

    if (!forms.isLengthValid(links, 1000)) {
      errorMessage = 'Too many links (max allowed: around 7)'
    } else if (!entry && !isExternalEvent && !eventService.areSubmissionsAllowed(event)) {
      errorMessage = 'Submissions are closed for this event'
    } else if (files.picture && files.picture.size > 0 && !fileStorage.isValidPicture(files.picture.path)) {
      errorMessage = 'Invalid picture format (allowed: PNG GIF JPG)'
    } else if (fields.division && !isExternalEvent && !forms.isIn(fields.division, Object.keys(event.get('divisions')))) {
      errorMessage = 'Invalid division'
    }

    if (!errorMessage) {
      // Save entry: Apply team changes
      let teamMembers = null
      if (fields.members) {
        if (!Array.isArray(fields.members)) {
          fields.members = [fields.members]
        }
        teamMembers = fields.members.map(s => parseInt(s))
        let ownerId
        if (!isCreation) {
          ownerId = entry.related('userRoles')
            .findWhere({ permission: constants.PERMISSION_MANAGE })
            .get('user_id')
        } else {
          ownerId = res.locals.user.get('id')
        }
        if (!teamMembers.includes(ownerId)) {
          teamMembers.push(ownerId)
        }
      }

      if (isCreation || securityService.canUserManage(user, entry, { allowMods: true })) {
        let division = fields['division'] || eventService.getDefaultDivision(event)
        if (event &&
          (event.get('status_entry') === enums.EVENT.STATUS_ENTRY.OPEN_UNRANKED || event.get('status_entry') === enums.EVENT.STATUS_ENTRY.CLOSED)) {
          if (!entry.has('division')) {
            // New entries are all unranked
            division = enums.DIVISION.UNRANKED
          } else {
            // Existing entries cannot change division
            division = entry.get('division')
          }
        }

        entry.set({
          'division': division,
          'allow_anonymous': fields['anonymous-enabled'] === 'on',
          'published_at': entry.get('published_at') || new Date()
        })

        let optouts = []
        if (fields['optout-graphics']) optouts.push('Graphics')
        if (fields['optout-audio']) optouts.push('Audio')
        entryDetails.set('optouts', optouts)

        res.locals.infoMessage = ''
        if (teamMembers !== null) {
          let teamChanges = await eventService.setTeamMembers(user, entry, teamMembers)
          if (teamChanges.numAdded > 0) {
            res.locals.infoMessage += teamChanges.numAdded + ' user(s) have been sent an invite to join your team. '
          }
          if (teamChanges.numRemoved > 0) {
            res.locals.infoMessage += teamChanges.numRemoved + ' user(s) have been removed from the team.'
          }
        }
      }

      // Save entry: Persist changes and side effects
      let eventCountRefreshNeeded = entry.hasChanged('published_at')
      if (entryDetails.get('body') === 'undefined') {
        // FIXME
        log.error('Preventing to blank the entry body (bug #248)')
        console.error(entryDetails)
      } else {
        await entryDetails.save()
      }
      await entry.save()
      if (eventCountRefreshNeeded) {
        eventService.refreshEventCounts(event) // No need to await
      }

      // Set or remove platforms.
      platformService.setEntryPlatforms(entry, platforms || [], { updateEntry: false })
      cache.user(res.locals.user).del('latestEntry')
      await entry.load(['userRoles.user', 'comments', 'details', 'tags'])

      // Save entry: Redirect to view upon success
      res.redirect(templating.buildUrl(entry, 'entry'))
      return
    }
  }

  res.render('entry/edit-entry', {
    entry,
    members: await eventService.findTeamMembers(entry, res.locals.user),
    allPlatforms: await platformService.fetchAllNames(),
    entryPlatforms: entry.get('platforms'),
    external: !res.locals.event,
    tags: entry.related('tags').map(tag => ({ id: tag.id, value: tag.get('value') })),
    errorMessage
  })
}

/**
 * Deletes an entry
 */
async function deleteEntry (req, res) {
  let entry = res.locals.entry
  if (res.locals.user && entry && securityService.canUserManage(res.locals.user, entry, { allowMods: true })) {
    await entry.load('posts')
    entry.related('posts').forEach(async function (post) {
      post.set('entry_id', null)
      await post.save()
    })
    await eventService.deleteEntry(entry)
    eventService.refreshEventCounts(entry.related('event')) // No need to await
    cache.user(res.locals.user).del('latestEntry')
  }

  if (res.locals.event) {
    res.redirect(templating.buildUrl(res.locals.event, 'event'))
  } else {
    res.redirect(templating.buildUrl(res.locals.user, 'user', 'entries'))
  }
}

/**
 * Leaves the team of an entry
 */
async function leaveEntry (req, res) {
  let entry = res.locals.entry
  let user = res.locals.user

  if (user && entry) {
    // Remove requesting user from the team
    let newTeamMembers = []
    entry.related('userRoles').each(function (userRole) {
      if (userRole.get('user_id') !== user.get('id')) {
        newTeamMembers.push(userRole.get('user_id'))
      }
    })
    await eventService.setTeamMembers(user, entry, newTeamMembers)

    cache.user(user).del('latestEntry')
  }

  if (res.locals.event) {
    res.redirect(templating.buildUrl(res.locals.event, 'event'))
  } else {
    res.redirect(templating.buildUrl(res.locals.user, 'user', 'entries'))
  }
}

/**
 * Saves a comment or vote made to an entry
 */
async function saveCommentOrVote (req, res) {
  let {entry, event, user} = res.locals

  // Security checks
  if (!user) {
    res.errorPage(403)
    return
  }

  let {fields} = await req.parseForm()
  if (fields['action'] === 'comment') {
    // Save comment
    let redirectUrl = await postController.handleSaveComment(
      fields, user, entry, templating.buildUrl(entry, 'entry'), event)
    res.redirect(redirectUrl)
  } else if (fields['action'] === 'vote') {
    // Save vote
    let i = 1
    let votes = []
    while (fields['vote-' + i] !== undefined) {
      votes.push(fields['vote-' + i])
      i++
    }
    if (await eventRatingService.canVoteOnEntry(res.locals.user, res.locals.entry)) {
      await eventRatingService.saveEntryVote(res.locals.user, res.locals.entry, res.locals.event, votes)
    }
    viewEntry(req, res)
  }
}

/**
 * Accept an invite to join an entry's team
 */
async function acceptInvite (req, res) {
  await eventService.acceptInvite(res.locals.user, res.locals.entry)
  res.redirect(templating.buildUrl(res.locals.entry, 'entry'))
}

/**
 * Decline an invite to join an entry's team
 */
async function declineInvite (req, res) {
  await eventService.deleteInvite(res.locals.user, res.locals.entry)
  res.redirect(templating.buildUrl(res.locals.user, 'user', 'feed'))
}

/**
 * Search for team mates with usernames matching a string
 * @param {string} req.query.name a string to search user names with.
 */
async function searchForTeamMate (req, res) {
  let errorMessage
  if (!req.query || !req.query.name) {
    errorMessage = 'No search parameter'
  }
  const nameFragment = forms.sanitizeString(req.query.name)
  if (!nameFragment || nameFragment.length < 3) {
    errorMessage = `Invalid name fragment: '${req.query.name}'`
  } else if (req.query.entryId && !forms.isId(req.query.entryId)) {
    errorMessage = 'Invalid entry ID'
  }

  if (!errorMessage) {
    let entry = null
    if (req.query.entryId) {
      entry = await eventService.findEntryById(req.query.entryId)
    }

    const matches = await eventService.searchForTeamMembers(nameFragment,
      res.locals.event ? res.locals.event.id : null, entry)

    const entryId = entry ? entry.get('id') : -1
    const getStatus = (match) => {
      switch (match.node_id) {
        case null: return 'available'
        case entryId: return 'member'
        default: return 'unavailable'
      }
    }

    const responseData = {
      matches: matches.map(match => ({
        id: match.id,
        text: match.title,
        avatar: match.avatar,
        status: getStatus(match)
      }))
    }
    res.json(responseData)
  } else {
    res.status(400).json({ error: errorMessage })
  }
}

/**
 * AJAX endpoint : Finds external event names
 */
async function searchForExternalEvents (req, res) {
  let errorMessage

  if (!req.query || !req.query.name) {
    errorMessage = 'No search parameter'
  }
  const nameFragment = forms.sanitizeString(req.query.name)
  if (!nameFragment || nameFragment.length < 3) {
    errorMessage = `Invalid name fragment: '${req.query.name}'`
  }

  if (!errorMessage) {
    let results = await eventService.searchForExternalEvents(nameFragment)
    res.json(results)
  } else {
    res.status(400).json({ error: errorMessage })
  }
}

/**
 * AJAX endpoint : Finds tags
 */
async function searchForTags (req, res) {
  let errorMessage

  if (!req.query || !req.query.name) {
    errorMessage = 'No search parameter'
  }
  const nameFragment = forms.sanitizeString(req.query.name)
  if (!nameFragment || nameFragment.length < 3) {
    errorMessage = `Invalid name fragment: '${req.query.name}'`
  }

  if (!errorMessage) {
    let matches = await tagService.searchTags(nameFragment)

    const responseData = {
      matches: matches.map(match => ({
        id: match.id,
        value: match.value
      }))
    }
    res.json(responseData)
  } else {
    res.status(400).json({ error: errorMessage })
  }
}
