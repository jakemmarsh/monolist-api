'use strict';

var _               = require('lodash');
var when            = require('when');
var models          = require('../models');
var ResponseHandler = require('../utils/ResponseHandler');
var ActivityManager = require('../utils/ActivityManager');

/* ====================================================== */

exports.get = function(req, res) {

  var getPost = function(postId) {
    var deferred = when.defer();

    models.Post.find({
      where: { id: postId },
      include: [
        {
          model: models.PostLike,
          as: 'Likes',
          include: [
            {
              model: models.User,
              attributes: ['id', 'username']
            }
          ]
        }
      ]
    }).then(function(post) {
      deferred.resolve(post);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  getPost(req.params.id).then(function(post) {
    ResponseHandler.handleSuccess(res, 200, post);
  }).catch(function(err) {
    ResponseHandler.handleError(res, err.status, err.body);
  });

};

/* ====================================================== */

exports.getNewest = function(req, res) {

  var getNewestPosts = function(limit, offset) {
    var deferred = when.defer();

    limit = ( limit && limit < 50 ) ? limit : 20;
    offset = offset || 0;

    models.Post.findAll({
      where: { GroupId: null },
      order: ['createdAt'],
      limit: limit,
      offset: offset,
      include: [
        {
          model: models.PostLike,
          as: 'Likes',
          include: [
            {
              model: models.User,
              attributes: ['id', 'username']
            }
          ]
        }
      ]
    }).then(function(posts) {
      deferred.resolve(posts);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  getNewestPosts(req.query.limit, req.query.offset).then(function(posts) {
    ResponseHandler.handleSuccess(res, 200, posts);
  }).catch(function(err) {
    ResponseHandler.handleError(res, err.status, err.body);
  });

};

/* ====================================================== */

exports.create = function(req, res) {

  var createPost = function(post, currentUser) {
    var deferred = when.defer();

    post = {
      body: post.body || post.Body,
      track: post.track || post.Track,
      GroupId: post.groupId || post.GroupId,
      UserId: currentUser.id
    };

    models.Post.create(post).then(function(savedPost) {
      deferred.resolve(savedPost);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  createPost(req.body, req.user)
  .then(ActivityManager.queue.bind(null, 'post', null, 'create', req.user.id))
  .then(function(createdPost) {
    ResponseHandler.handleSuccess(res, 200, createdPost);
  }, function(err) {
    ResponseHandler.handleError(res, err.status, err.body);
  });

};

/* ====================================================== */

exports.like = function(req, res) {

  var likePost = function(postId, userId) {
    var deferred = when.defer();
    var attributes = {
      PostId: postId,
      UserId: userId
    };

    models.PostLike.find({
      where: attributes
    }).then(function(retrievedLike) {
      if ( _.isEmpty(retrievedLike) ) {
        models.PostLike.create(attributes).then(function(savedLike) {
          deferred.resolve(savedLike);
        }).catch(function(err) {
          deferred.reject({ status: 500, body: err });
        });
      } else {
        retrievedLike.destroy().then(function() {
          deferred.resolve('Like successfully removed.');
        }).catch(function(err) {
          deferred.reject({ status: 500, body: err });
        });
      }
    });

    return deferred.promise;
  };

  likePost(req.params.id, req.user.id)
  .then(function(result) {
    // Only create activity if a like object was returned,
    // because otherwise a like was deleted
    if ( _.isObject(result) ) {
      ActivityManager.queue('post', req.params.id, 'like', req.user.id)
    }

    return when(result);
  })
  .then(function(like) {
    ResponseHandler.handleSuccess(res, 200, like);
  }, function(err) {
    ResponseHandler.handleError(res, err.status, err.body);
  });

};

/* ====================================================== */

exports.addComment = function(req, res) {

  var createComment = function(postId, comment, userId) {
    var deferred = when.defer();

    comment = {
      body: comment.body,
      PostId: postId,
      UserId: userId
    };

    models.PostComment.create(comment).then(function(savedComment) {
      deferred.resolve(savedComment);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  createComment(req.params.id, req.body, req.user.id)
  .then(ActivityManager.queue.bind(null, 'post', req.params.id, 'addComment', req.user.id))
  .then(function(comment) {
    ResponseHandler.handleSuccess(res, 200, comment);
  }, function(err) {
    ResponseHandler.handleError(res, err.status, err.body);
  });

};

/* ====================================================== */

exports.removeComment = function(req, res) {

  var deleteComment = function(postId, commentId, user) {
    var deferred = when.defer();

    models.PostComment.find({
      where: {
        id: commentId,
        PostId: postId
      }
    }).then(function(retrievedComment) {
      if ( user.role === 'admin' || retrievedComment.UserId === user.id ) {
        retrievedComment.destroy().then(function() {
          deferred.resolve('Comment successfully removed.');
        }).catch(function(err) {
          deferred.reject({ status: 500, body: err });
        });
      } else {
        deferred.reject({ status: 401, body: 'Current user does not have permission to delete comment: ' + user.id });
      }
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  deleteComment(req.params.id, req.params.commentId, req.user).then(function(resp) {
    ResponseHandler.handleSuccess(res, 200, resp);
  }).catch(function(err) {
    ResponseHandler.handleError(res, err.status, err.body);
  });

};

/* ====================================================== */

exports.delete = function(req, res) {



};