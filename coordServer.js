
var VERSION = 0.15;

var MILLISECONDS_BETWEEN_TICKS = 10*1000;

var METERS_BETWEEN_NOTIFICATIONS = 0;

var ERROR_USER_NOT_FOUND = "User not found";

var io = require('socket.io').listen(8010);
io.set('log level', 1);

var googleapis = require('googleapis');

var CLIENT_ID = '825197984838.apps.googleusercontent.com';
var CLIENT_SECRET = 'tSfhW7Yx3razjhnpiX1Gcfyy';
var REDIRECT_URL = 'http://www.mattiaserlo.com:8081/glasstrack/oauth2callback';
var SCOPE = 'https://www.googleapis.com/auth/glass.location ' +
			'https://www.googleapis.com/auth/glass.timeline';

var updateIndex = 0;
var gUser = null;

console.log("coordServer version " + VERSION);


function generateUrlForUserToGivePermission(user) {
	console.log("Generate a url for asking the user's permission");
	// Generate a url where the user can allow offline access
	// and permissions for the requested scope.
	var url = user.oauth2client.generateAuthUrl({
		access_type: 'offline',
		scope: SCOPE
	});

	// Show a URL to the user for him to visit, and where he can accept the
	// app to get access to the current scope
	console.log("Ask the user to visit this url: " + url);

	return url;
}

function getAccessToken(user, code, callback) {
	user.oauth2client.getToken(code, function(err, tokens) {
		// contains an access_token and optionally a refresh_token.
		// save them permanently.
		console.log("Received token(s) and stored in user data");

		console.log("tokens: " + tokens);

		user.storedTokens = tokens;

		user.oauth2client.credentials = tokens;

		callback(user);
	});
}

function accessTokenAcquired(user) {
	console.log("accessTokenAquired");
	user.googleApiAvailable = true;
}

function PointOfInterest(latitude, longitude, radius, message) {
	this.latitude = latitude;
	this.longitude = longitude;
	this.radius = radius;
	this.message = message;
}

function User(name) {
	this.name = name;
	this.tracking = false;
	this.pushSpeedInfoToGlass = true;
	this.coordinates = new Array();
	this.coordinateAtLastNotification = null;
	this.timeAtLastNotification = null;
	this.timelineId = -1;
	this.totalDistanceMoved = 0;
	this.pointsOfInterest = new Array();
	this.storedTokens = null;
	this.googleApiAvailable = false;
	this.oauth2client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URL);
	this.followers = new Array();
	this.timer = null;
	console.log("Created new user.  this.oauth2client = " + this.oauth2client);
}

var users = new Array();

function findUser(name) {
	var i;
	for (i=0; i<users.length; i++) {
		if (users[i].name == name) {
			return users[i];
		}
	}
	return null;
}

function removeUser(name) {
	var i;
	for (i=0; i<users.length; i++) {
		if (users[i].name == name) {
			if (users[i].timer != null) {
				clearTimeout(users[i].timer);
			}
			for (var j=i; j<users.length-1; j++) {
				users[j] = users[j+1];
			}
			users.length--;		
			break;
		}
	}
	
	broadcastUserList();
}

function addFollower(user, followerSocket) {
	user.followers[user.followers.length] = followerSocket;
}

function removeFollower(user, followerSocket) {
	var i;
	for (i=0; i<user.followers.length; i++) {
		if (user.followers[i] == followerSocket) {
			for (var j=i; j<user.followers.length-1; j++) {
				user.followers[j] = user.followers[j+1];
			}
			user.followers.length--;
			return;
		}
	}
}


// Geographics

function distanceBetweenPoints(x0, y0, x1, y1) {
	return Math.sqrt( (x0-x1) * (x0-x1) + (y0-y1) * (y0-y1) );
}

function lineAndCircleCollides(	line_x0, line_y0,
								line_x1, line_y1,
								circle_x, circle_y, circle_radius) {

	var line_k = (line_y1 - line_y0) / (line_x1 - line_x0);
	var perpendicular_line_k = -1 / line_k;
	var line_m = line_y0 - (line_k * line_x0);
	var perpendicular_line_m = circle_y - (perpendicular_line_k * circle_x);

	var lines_intersection_point_x = (perpendicular_line_m - line_m) / (line_k - perpendicular_line_k);
	var lines_intersection_point_y = line_k * lines_intersection_point_x + line_m;

	// Now we know where the two infinitely long lines intersect.
	// Now check if this intersection point is within the endpoints of the limited line.
	var smallest_x, largest_x, smallest_y, largest_y;
	if (line_x0 < line_x1) {
		smallest_x = line_x0;
		largest_x = line_x1;
	} else {
		smallest_x = line_x1;
		largest_x = line_x0;
	}
	if (line_y0 < line_y1) {
		smallest_y = line_y0;
		largest_y = line_y1;
	} else {
		smallest_y = line_y1;
		largest_y = line_y0;
	}
	if (lines_intersection_point_x >= smallest_x && lines_intersection_point_x <= largest_x &&
		lines_intersection_point_y >= smallest_y && lines_intersection_point_y <= largest_y) {
		// Yes, the intersection point is within the line
		// Now check the distance between the intersection point and the circle's center
		// If this distance is <= the circle's radius, it means the line and the circle intersect
		if (distanceBetweenPoints(	lines_intersection_point_x, lines_intersection_point_y,
									circle_x, circle_y) <= circle_radius) {
			return true;
		}
	} else {
		// Check also the distance to the line's endpoints.
		// If any of those distances are <= the circle's radius, we have intersection.
		if (distanceBetweenPoints(	line_x0, line_y0,
									circle_x, circle_y) <= circle_radius) {
			return true;
		}
		if (distanceBetweenPoints(	line_x1, line_y1,
									circle_x, circle_y) <= circle_radius) {
			return true;
		}
	}
	return false;
}

function trackingTick(user) {
	console.log("Track tick for name " + user.name + " who has " + user.followers.length + " followers");

	if (user.googleApiAvailable) {
		googleapis
		.discover('mirror', 'v1')
		.execute(function(err, client) {
			console.log("Try to get location. user.oauth2client: " + JSON.stringify(user.oauth2client));											
			client
				.mirror.locations.get({ id: 'latest' })
				.withAuthClient(user.oauth2client)
				.execute(function googleApiCallback (err, resp) {
					if (err) {
						console.log('An error occurred');
					} else {
						// Got response from the google api call
						console.log("Got a coordinate from user " + user.name);
						var newCoordinate = new Object();
						newCoordinate.latitude = resp.latitude;
						newCoordinate.longitude = resp.longitude;
						var distance = 0;
						
						if (user.coordinates.length > 0) {
							distance = distanceBetweenPoints(	user.coordinates[user.coordinates.length-1].latitude,
																user.coordinates[user.coordinates.length-1].longitude,
																resp.latitude,
																resp.longitude ) / 111000;
																
							user.totalDistanceMoved += Math.floor(distance);
						}
						
						user.coordinates[user.coordinates.length] = newCoordinate;

						// Inform all of this user's followers about this new location
						for (var i=0; i<user.followers.length; i++) {
							user.followers[i].emit('coordinate', {	name: user.name,
																	coordinate: newCoordinate,
																	totalDistanceMoved: user.totalDistanceMoved } );
						}

						var currentTime = new Date();
						var metersPerSecond = 0;
						
						// If the user has moved far enough since our last notification,
						// then notify the user again now.
						if (user.coordinateAtLastNotification != null) {
							distance = distanceBetweenPoints(	user.coordinateAtLastNotification.latitude,
																user.coordinateAtLastNotification.longitude,
																resp.latitude,
																resp.longitude ) / 111000;
																
							var secondsElapsed = (currentTime.getTime() - user.timeAtLastNotification.getTime()) / 1000;

							metersPerSecond = distance / secondsElapsed;
							metersPerSecond = Math.floor(metersPerSecond * 100) / 100;
						}
						
						if (user.pushSpeedInfoToGlass && (user.coordinateAtLastNotification == null ||
							distance >= METERS_BETWEEN_NOTIFICATIONS)) {

							user.coordinateAtLastNotification = new Object();
							user.coordinateAtLastNotification.latitude = resp.latitude;
							user.coordinateAtLastNotification.longitude = resp.longitude;
							user.timeAtLastNotification = currentTime;
							
							// Send a timeline event, or edit the old one

							var timelineResource = {'text': "Distance: " + user.totalDistanceMoved + " m.\nSpeed: " + metersPerSecond + " m/s.\nUpdate: " + updateIndex,
													'notification': {'level': 'default'},
													'menuItems': [{'action': 'READ_ALOUD'}, {'action': 'DELETE'}],
													'speakableText': 'Your speed is ' + metersPerSecond + ' meter per second'};
							
							if (user.timelineId == -1) {
								googleapis.discover('mirror', 'v1')
									.execute(function(err, client) {
										console.log("Insert to timeline.");		
										client.mirror.timeline.insert(timelineResource)
											.withAuthClient(user.oauth2client)
											.execute(function(err, result, res) {
												if (result != undefined) {
													console.log("Remember this timeline id " + result.id);
													user.timelineId = result.id;
													updateIndex++;
												}
									});
								});
							} else {
								googleapis.discover('mirror', 'v1')
									.execute(function(err, client) {
										console.log("Update existing timeline id " + user.timelineId);
										client.mirror.timeline.update({'id': user.timelineId}, timelineResource)
											.withAuthClient(user.oauth2client)
											.execute(function(err, result, res) {
												updateIndex++;
									});
								});						
							}
						}

						// If the user has any points of interest, go through them here
						// and if we are close to any, send the corresponding message via the Mirror API
						// ...
						if (user.coordinates.length > 1) {
							i = 0;
							while (i < user.pointsOfInterest.length) {
								if (lineAndCircleCollides(	user.coordinates[user.coordinates.length-2].longitude,
															user.coordinates[user.coordinates.length-2].latitude,

															user.coordinates[user.coordinates.length-1].longitude,
															user.coordinates[user.coordinates.length-1].latitude,

															user.pointsOfInterest[i].longitude,
															user.pointsOfInterest[i].latitude,

															user.pointsOfInterest[i].radius/111000)) {

									console.log("Line and circle collides!");
									
									var timelineResource = {'text': "" + user.pointsOfInterest[i].message ,
															'notification': {'level': 'default'},
															'menuItems': [{'action': 'READ_ALOUD'}, {'action': 'DELETE'}],
															'speakableText': user.pointsOfInterest[i].message};

									googleapis.discover('mirror', 'v1')
										.execute(function(err, client) {
											console.log("Call timeline insert");
											client.mirror.timeline.insert(timelineResource)
											.withAuthClient(user.oauth2client)
											.execute(function(err, result, res) {
												console.log("err: " + err);
												console.log("result: " + result);
												console.log("res: " + res);
											// ...
										});
									});
							
									// Now delete this point of interest since it has been consumed
									for (var j=i; j<user.pointsOfInterest.length-1; j++) {
										user.pointsOfInterest[j] = user.pointsOfInterest[j+1];
									}
									user.pointsOfInterest.length--;
									
									// Ask all followers to remove this point of interest
									for (var j=0; j<user.followers.length; j++) {
										console.log("sending removePointOfInterest message");
										user.followers[j].emit('removePointOfInterest', {	name: user.name,
																							index: i });
									}											
								} else {
									i++;
								}
							}
						}
					}
				});
		});
	} else {
		console.log("Google API not available");
	}
	user.timer = setTimeout(trackingTick, MILLISECONDS_BETWEEN_TICKS, user);
}

// Communications

function broadcastUserList() {
	var tempUsersArray = [];
	for (var i=0; i<users.length; i++) {
		var tempUser = new Object();
		tempUser.name = users[i].name;
		tempUser.totalDistanceMoved = users[i].totalDistanceMoved;
		tempUser.speed = users[i].speed;
		tempUsersArray.push(tempUser);
	}
	io.sockets.emit('userList', { users: tempUsersArray } );
}

function sendUserList(socket) {
		var tempUsersArray = [];
		for (var i=0; i<users.length; i++) {
			var tempUser = new Object();
			tempUser.name = users[i].name;
			tempUser.tracking = users[i].tracking;
			tempUser.totalDistanceMoved = users[i].totalDistanceMoved;
			tempUser.speed = users[i].speed;
			tempUsersArray.push(tempUser);
		}
		socket.emit('userList', { users: tempUsersArray } );
}

io.sockets.on('connection', function (socket) {
	console.log("Someone connected");

	socket.on('authenticate', function (data) {
		var user;
		if (user = findUser(data.name)) {
			if (user.timer != null) {
				clearTimeout(user.timer);
			}
		} else {
			user = new User(data.name);
			users[users.length] = user;

			broadcastUserList();
		}

		gUser = user;	// TODO: ugly!

		var authUrl = generateUrlForUserToGivePermission(user);
		socket.emit('authenticationUrl', { url: authUrl } );
	});

	socket.on('getUserList', function (data) {
		sendUserList(socket);
	});

	socket.on('removeUser', function (data) {
		removeUser(data.name);
		sendUserList(socket);
	});

	socket.on('getCoordinates', function (data) {
		console.log("Got getCoordinates request");
		var user;
		if (user = findUser(data.name)) {
			socket.emit('coordinates', {name: data.name,
										coordinates: user.coordinates } );
		}
	});

	socket.on('clearCoordinates', function (data) {
		console.log("Got clearCoordinates request");
		var user;
		if (user = findUser(data.name)) {
			user.coordinates = new Array();
		}
	});

	socket.on('startFollowing', function (data) {
		console.log("Got startFollowing request");
		var user;
		if (user = findUser(data.name)) {
			// To make sure we don't register multiple times, 
			// remove this socket if it was already following
			removeFollower(user, socket);
			addFollower(user, socket);
			// Send the user's coordinates to the client
			socket.emit('coordinates', {name: data.name,
										coordinates: user.coordinates } );
		} else {
			socket.emit('error', {	type: ERROR_USER_NOT_FOUND } );
		}
	});

	socket.on('startTracking', function (data) {
		console.log("Got startTracking request");
		var user;
		if (user = findUser(data.name)) {
			if (user.timer != null) {
				clearTimeout(user.timer);
			}
		} else {
			user = new User(data.name);
			users[users.length] = user;
			broadcastUserList();
		}
		user.tracking = true;
		trackingTick(user);		
	});

	socket.on('stopTracking', function (data) {
		console.log("Got stopTracking request");
		for (var i=0; i<users.length; i++) {
			if (users[i].name == data.name) {
				if (users[i].timer != null) {
					clearTimeout(users[i].timer);
					users[i].timer = null;
				}
				if (users[i].tracking) {
					users[i].tracking = false;
				
				}
				break;
			}
		}
	});

	socket.on('startPushingSpeedInfoToGlass', function (data) {
		console.log("Got startPushingSpeedInfoToGlass request");
		var user;
		if (user = findUser(data.name)) {
			user.pushSpeedInfoToGlass = true;
		}
	});

	socket.on('stopPushingSpeedInfoToGlass', function (data) {
		console.log("Got stopPushingSpeedInfoToGlass request");
		var user;
		if (user = findUser(data.name)) {
			user.pushSpeedInfoToGlass = false;
		}
	});

	socket.on('addPointOfInterest', function (data) {
		console.log("Got addPointOfInterest request");
		var user;
		if (user = findUser(data.name)) {
			var pointOfInterest = new PointOfInterest(data.lat, data.lng, data.radius, data.message);
			user.pointsOfInterest[user.pointsOfInterest.length] = pointOfInterest;	
		}
	});

	socket.on('movePointOfInterest', function (data) {
		console.log("Got movePointOfInterest request");
		var user;
		if (user = findUser(data.name)) {
			if (user.pointsOfInterest && user.pointsOfInterest.length > data.index) {
				user.pointsOfInterest[data.index].latitude = data.lat;
				user.pointsOfInterest[data.index].longitude = data.lng;
			}
		}
	});

	socket.on('removePointOfInterest', function (data) {
		console.log("Got removePointOfInterest request");
		var user;
		if (user = findUser(data.name)) {
			if (user.pointsOfInterest && user.pointsOfInterest.length > data.index) {
				for (var i=data.index; i<user.pointsOfInterest.length-1; i++) {
					user.pointsOfInterest[i] = user.pointsOfInterest[i+1];
				}
				user.pointsOfInterest.length--;				
			}
		}
	});

	socket.on('setPointOfInterestRadius', function (data) {
		console.log("Got setPointOfInterestRadius request");
		var user;
		if (user = findUser(data.name)) {
			if (user.pointsOfInterest && user.pointsOfInterest.length > data.index) {
				user.pointsOfInterest[data.index].radius = data.radius;
				// TODO:
				// Perhaps the circle's radius was increased enough to encompass the user
				// We ought to check now if the circle encompasses the user			
			}
		}
	});

	socket.on('disconnect', function (data) {
		// If this client was following anyone, stop following them
		for (var i=0; i<users.length; i++) {
			for (var j=0; j<users[i].followers.length; j++) {
				if (users[i].followers[j] == socket) {
					removeFollower(users[i], socket);
				}
			}
		}
	});
});

// Express server for receiving the authorization from Google

var fs = require("fs");
var port = 8081;
var express = require("express");

var app = express();

app.get("/glasstrack/oauth2callback", function(request, response){

	console.log("got oauth2callback");

	response.send('Authorization completed. Check the Tracking checkbox to start tracking.');

	var code = request.query.code;

	console.log("call getAccessToken");

	getAccessToken(gUser, code, accessTokenAcquired);
});

app.listen(port);

