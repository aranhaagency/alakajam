import links from "server/core/links";
import likeService from "../like/like.service";
import postService from "../post.service";

/**
 * Likes or unlikes a post
 */
export async function likePost(req, res) {
  const { user, post } = res.locals;

  if (user) {
    if (req.body.like && likeService.isValidLikeType(req.body.like)) {
      await likeService.like(post, user.get("id"), req.body.like);
    } else if (req.body.unlike) {
      await likeService.unlike(post, user.get("id"));
    }
  }

  if (req.body.ajax) {
    res.render("post/like/ajax-likes", {
      post: await postService.findPostById(post.get("id")),
      userLikes: await likeService.findUserLikeInfo([post], user),
    });
  } else {
    res.redirect(req.query.redirect || links.routeUrl(post, "post"));
  }
}
