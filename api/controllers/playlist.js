'use strict';

var when          = require('when');
var _             = require('lodash');
var Sequelize     = require('sequelize');
var models        = require('../models');
var awsRoutes     = require('./aws');
var notifications = require('../utils/notifications');

/* ====================================================== */

function ensureCurrentUserCanEdit(req, playlistId) {

  var mainDeferred = when.defer();

  var checkUserPlaylists = function() {
    var deferred = when.defer();

    models.Playlist.find({
      where: { id: playlistId, UserId: req.user.id }
    }).then(function(playlist) {
      if ( !_.isEmpty(playlist) ) {
        deferred.resolve(true);
      } else {
        // Resolve to still pass to checkCollaborations
        deferred.resolve(false);
      }
    }).catch(function() {
      deferred.reject();
    });

    return deferred.promise;
  };

  var checkCollaborations = function(userPlaylistsResult) {
    var deferred = when.defer();

    if ( userPlaylistsResult ) {
      // Already been confirmed that user can edit the playlist
      deferred.resolve();
    } else {
      models.Collaboration.findAll({
        where: { PlaylistId: playlistId, UserId: req.user.id }
      }).then(function(collaborations) {
        if ( !_.isEmpty(collaborations) ) {
          deferred.resolve();
        } else {
          deferred.reject();
        }
      }).catch(function() {
        deferred.reject();
      });
    }

    return deferred.promise;
  };

  checkUserPlaylists()
  .then(checkCollaborations)
  .then(function() {
    mainDeferred.resolve();
  }).catch(function() {
    mainDeferred.reject({ status: 401, body: 'Current user does not have permission to edit playlist: ' + req.params.id });
  });

  return mainDeferred.promise;

}

/* ====================================================== */

exports.get = function(req, res) {

  var getPlaylist = function(slug, ownerName, currentUser) {
    var deferred = when.defer();
    var currentUserIsCreator;
    var currentUserIsCollaborator;
    var query;

    currentUser = currentUser || {};

    // if only passed an ID
    if ( isFinite(ownerName) ) {
      query = { id: ownerName };
    } else {
      query = { slug: slug };
    }

    models.Playlist.find({
      where: query,
      include: [
        {
          model: models.Group,
          where: { slug: ownerName }
        },
        {
          model: models.Collaboration,
          attributes: ['UserId']
        },
        {
          model: models.Track,
          include: [
            {
              model: models.User,
              attributes: ['id', 'username']
            },
            {
              model: models.TrackComment,
              as: 'Comments',
              include: [{
                model: models.User,
                attributes: ['id', 'username', 'imageUrl']
              }]
            },
            {
              model: models.TrackUpvote,
              as: 'Upvotes'
            },
            {
              model: models.TrackDownvote,
              as: 'Downvotes'
            }
          ]
        },
        {
          model: models.PlaylistFollow,
          as: 'Followers'
        },
        {
          model: models.PlaylistLike,
          as: 'Likes',
          attributes: ['id', 'UserId']
        },
        {
          model: models.PlaylistPlay,
          as: 'Plays',
          attributes: ['id']
        }
      ]
    }).then(function(playlist) {
      if ( _.isEmpty(playlist) ) {
        deferred.reject({ status: 404, body: 'Playlist could not be found.' });
      } else {
        currentUserIsCreator = currentUser.id === playlist.UserId;
        currentUserIsCollaborator = !!_.where(playlist.Collaborations, { UserId: currentUser.id }).length;

        if ( currentUserIsCreator || currentUserIsCollaborator || playlist.privacy === 'public' ) {
          deferred.resolve(playlist);
        } else {
          deferred.reject({
            status: 401,
            body: 'Current user does not have permission to view that playlist.'
          });
        }
      }
    }).catch(function(err) {
      console.log('error getting playlist:', err);
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  getPlaylist(req.params.slug, req.params.ownerName, req.user).then(function(playlist) {
    res.status(200).json(playlist);
  }, function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.search = function(req, res) {

  var searchPlaylists = function(query) {
    var deferred = when.defer();

    models.Playlist.findAll({
      where: Sequelize.and(
        Sequelize.or(
          { title: { ilike: '%' + query + '%' } },
          { tags: { ilike: '%' + query + '%' } }
        ),
        Sequelize.or(
          { privacy: 'public' },
          { UserId: req.user ? req.user.id : null }
        )
      )
    }).then(function(retrievedPlaylists) {
      deferred.resolve(retrievedPlaylists);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  searchPlaylists(req.params.query).then(function(playlists) {
    res.status(200).json(playlists);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.getTrending = function(req, res) {

  var getLikes = function() {
    var deferred = when.defer();

    models.PlaylistLike.findAll({
      attributes: ['PlaylistId'],
      order: ['createdAt']
    }).then(function(likes) {
      deferred.resolve(likes);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  var getPlays = function(likes) {
    var deferred = when.defer();

    models.PlaylistPlay.findAll({
      attributes: ['PlaylistId'],
      order: ['createdAt']
    }).then(function(plays) {
      deferred.resolve([likes, plays]);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  var process = function(data) {
    var deferred = when.defer();
    var likes = _.countBy(data[0], function(like) { return like.PlaylistId; });
    var plays = _.countBy(data[0], function(play) { return play.PlaylistId; });
    var merged = _.merge(likes, plays, function(a, b) { return a + b; });
    var formatted = [];
    var limit = ( req.query.limit && req.query.limit < 50 ) ? req.query.limit : 20;
    var results;

    _.forOwn(merged, function(num, key) {
      formatted.push({
        'PlaylistId': parseInt(key),
        'NumInteractions': num
      });
    });

    results = _.sortBy(formatted, function(item) { return -item.NumInteractions; }).slice(0, limit);

    deferred.resolve(_.pluck(results, 'PlaylistId'));

    return deferred.promise;
  };

  var getPlaylists = function(playlistIds) {
    var deferred = when.defer();

    models.Playlist.findAll({
      where: Sequelize.and(
        { id: playlistIds },
        Sequelize.or(
          { privacy: 'public' },
          { UserId: req.user ? req.user.id : null }
        )
      ),
      include: [
        {
          model: models.PlaylistLike,
          as: 'Likes'
        },
        {
          model: models.PlaylistPlay,
          as: 'Plays'
        }
      ]
    }).then(function(playlists) {
      deferred.resolve(playlists);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  getLikes()
  .then(getPlays)
  .then(process)
  .then(getPlaylists)
  .then(function(playlists) {
    res.status(200).json(playlists);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body });
  });

};

/* ====================================================== */

exports.getNewest = function(req, res) {

  var getPlaylists = function(limit) {
    var deferred = when.defer();
    limit = ( limit && limit < 50 ) ? limit : 20;

    models.Playlist.findAll({
      where: Sequelize.or(
        { privacy: 'public' },
        { UserId: req.user ? req.user.id : null }
      ),
      limit: limit,
      order: ['createdAt'],
      include: [
        {
          model: models.PlaylistLike,
          as: 'Likes',
          attributes: ['id', 'UserId']
        },
        {
          model: models.PlaylistPlay,
          as: 'Plays',
          attributes: ['id']
        }
      ]
    }).then(function(playlists) {
      deferred.resolve(playlists);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  getPlaylists(req.query.limit).then(function(playlists) {
    res.status(200).json(playlists);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body });
  });

};

/* ====================================================== */

exports.create = function(req, res) {

  var createPlaylist = function(playlist, currentUser) {
    var deferred = when.defer();

    playlist = {
      ownerName: currentUser.username,
      title: playlist.title || playlist.Title,
      tags: playlist.tags || playlist.Tags,
      privacy: playlist.privacy || playlist.Privacy
    };

    playlist.tags = _.map(playlist.tags, function(tag) { return tag.toLowerCase(); });

    models.Playlist.create(playlist).then(function(savedPlaylist) {
      deferred.resolve(savedPlaylist);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  createPlaylist(req.body, req.user).then(function(resp) {
    res.status(200).json(resp);
  }, function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.recordPlay = function(req, res) {

  var userId = req.user ? req.user.id : null;

  var createPlay = function(currentUserId, playlistId) {
    var deferred = when.defer();
    var attributes = {
      PlaylistId: playlistId,
      UserId: currentUserId
    };

    models.PlaylistPlay.create(attributes).then(function(createdPlay) {
      deferred.resolve(createdPlay);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  createPlay(userId, req.params.id).then(function(createdPlay) {
    res.status(200).json(createdPlay);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.follow = function(req, res) {

  var followPlaylist = function(playlistId, currentUserId) {
    var deferred = when.defer();
    var attributes = {
      UserId: currentUserId,
      PlaylistId: playlistId
    };

    models.PlaylistFollow.find({
      where: attributes
    }).then(function(retrievedFollowing) {
      if ( _.isEmpty(retrievedFollowing) ) {
        models.PlaylistFollow.create(attributes).then(function(savedFollow) {
          deferred.resolve(savedFollow);
        }).catch(function(err) {
          deferred.reject({ status: 500, body: err });
        });
      } else {
        retrievedFollowing.destroy().then(function() {
          deferred.resolve('Following successfully removed.');
        }).catch(function(err) {
          deferred.reject({ status: 500, body: err });
        });
      }
    });

    return deferred.promise;
  };

  followPlaylist(req.params.id, req.user.id).then(function(playlistFollow) {
    res.status(200).json(playlistFollow);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.like = function(req, res) {

  var likePlaylist = function(playlistId, userId) {
    var deferred = when.defer();
    var attributes = {
      PlaylistId: playlistId,
      UserId: userId
    };

    models.PlaylistLike.find({
      where: attributes
    }).then(function(retrievedLike) {
      if ( _.isEmpty(retrievedLike) ) {
        models.PlaylistLike.create(attributes).then(function(savedLike) {
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

  likePlaylist(req.params.id, req.user.id).then(function(like) {
    res.status(200).json(like);
  }, function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.addCollaborator = function(req, res) {

  var addCollaboration = function() {
    var deferred = when.defer();
    var collaboration = {
      PlaylistId: req.params.playlistId,
      UserId: req.params.userId
    };

    models.Collaboration.create(collaboration).then(function(createdCollaboration) {
      deferred.resolve(createdCollaboration);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  ensureCurrentUserCanEdit(req, req.params.playlistId)
  .then(addCollaboration)
  .then(function(collaboration) {
    res.status(200).json(collaboration);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.removeCollaborator = function(req, res) {

  var removeCollaboration = function() {
    var deferred = when.defer();

    models.Collaboration.destroy({
      where: {
        PlaylistId: req.params.playlistId,
        UserId: req.params.userId
      }
    }).then(function() {
      deferred.resolve();
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  ensureCurrentUserCanEdit(req, req.params.playlistId)
  .then(removeCollaboration)
  .then(function() {
    res.status(200).json({ status: 200, message: 'Collaborator successfully removed.' });
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.addTrack = function(req, res) {

  var createTrack = function() {
    var deferred = when.defer();
    var track = {
      PlaylistId: req.params.id || req.body.playlistId || req.body.PlaylistId,
      UserId: req.user.id || req.body.userId || req.body.UserId,
      title: req.body.title || req.body.Title,
      artist: req.body.artist || req.body.Artist,
      duration: req.body.duration || req.body.Duration,
      source: req.body.source || req.body.Source,
      sourceParam: req.body.sourceParam || req.body.SourceParam,
      sourceUrl: req.body.sourceUrl || req.body.SourceUrl,
      imageUrl: req.body.imageUrl || req.body.ImageUrl
    };

    models.Track.create(track).then(function() {
      deferred.resolve();
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  var fetchPlaylist = function() {
    var deferred = when.defer();

    models.Playlist.find({
      where: { id: req.params.id },
      include: [
        {
          model: models.PlaylistLike,
          as: 'Likes'
        },
        {
          model: models.PlaylistPlay,
          as: 'Plays'
        }
      ]
    }).then(function(playlist) {
      deferred.resolve(playlist);
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  ensureCurrentUserCanEdit(req, req.params.id)
  .then(createTrack)
  .then(fetchPlaylist)
  .then(function(modifiedPlaylist) {
    res.status(200).json(modifiedPlaylist);
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.removeTrack = function(req, res) {

  var deleteTrack = function() {
    var deferred = when.defer();

    models.Track.destroy({
      where: { id: req.params.trackId }
    }).then(function() {
      deferred.resolve();
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  ensureCurrentUserCanEdit(req, req.params.playlistId)
  .then(deleteTrack)
  .then(function() {
    res.status(200).json({ status: 200, message: 'Track successfully deleted.' });
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};

/* ====================================================== */

exports.delete = function(req, res) {

  var originalImageUrl;

  var findAndEnsureUserCanDelete = function(currentUser, playlistIdToDelete) {
    var deferred = when.defer();

    models.Playlist.find({
      where: { id: playlistIdToDelete }
    }).then(function(playlist) {
      if ( currentUser.role !== 'admin' || playlist.ownerId === currentUser.id ) {
        deferred.resolve(playlist);
      } else {
        deferred.reject({ status: 401, body: 'You do not have permission to delete another user\'s playlist.'});
      }
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  var deletePlaylist = function(playlist) {
    var deferred = when.defer();

    playlist.destroy().then(function() {
      deferred.resolve();
    }).catch(function(err) {
      deferred.reject({ status: 500, body: err });
    });

    return deferred.promise;
  };

  var deleteOriginalImage = function() {
    var deferred = when.defer();

    if ( !_.isEmpty(originalImageUrl) ) {
      awsRoutes.delete(originalImageUrl).then(function(res) {
        deferred.resolve(res);
      }).catch(function() {
        // Still resolve since playlist was successfully deleted
        deferred.resolve();
      });
    } else {
      deferred.resolve();
    }

    return deferred.promise;
  };

  findAndEnsureUserCanDelete(req.user, parseInt(req.params.id))
  .then(deletePlaylist)
  .then(deleteOriginalImage)
  .then(function() {
    res.status(200).json({ status: 200, message: 'Playlist successfully deleted.' });
  }).catch(function(err) {
    res.status(err.status).json({ status: err.status, message: err.body.toString() });
  });

};