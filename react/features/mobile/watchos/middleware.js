// @flow

import { Platform } from 'react-native';
import * as watch from 'react-native-watch-connectivity';

import { appNavigate } from '../../app';

import { APP_WILL_MOUNT } from '../../base/app';
import { CONFERENCE_JOINED } from '../../base/conference';
import { getInviteURL, isInviteURLReady } from '../../base/connection';
import { setAudioMuted } from '../../base/media';
import {
    MiddlewareRegistry,
    StateListenerRegistry,
    toState
} from '../../base/redux';
import { toURLString } from '../../base/util';

import { setConferenceTimestamp, setSessionId } from './actions';
import { CMD_HANG_UP, CMD_JOIN_CONFERENCE, CMD_SET_MUTED, MAX_RECENT_URLS } from './constants';

const logger = require('jitsi-meet-logger').getLogger(__filename);

const watchOSEnabled = Platform.OS === 'ios';

// Handles the recent URLs state sent to the watch
watchOSEnabled && StateListenerRegistry.register(
    /* selector */ state => state['features/recent-list'],
    /* listener */ (recentListState, { getState }) => {
        _updateApplicationContext(getState);
    });

// Handles the mic muted state sent to the watch
watchOSEnabled && StateListenerRegistry.register(
    /* selector */ state => _isAudioMuted(state),
    /* listener */ (isAudioMuted, { getState }) => {
        _updateApplicationContext(getState);
    });

// Handles the conference URL state sent to the watch
watchOSEnabled && StateListenerRegistry.register(
    /* selector */ state => _getCurrentConferenceUrl(state),
    /* listener */ (currentUrl, { dispatch, getState }) => {
        dispatch(setSessionId());
        _updateApplicationContext(getState);
    });

/**
 * Middleware that captures conference actions.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
watchOSEnabled && MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case APP_WILL_MOUNT:
        _appWillMount(store);
        break;
    case CONFERENCE_JOINED:
        store.dispatch(setConferenceTimestamp(new Date().getTime()));
        _updateApplicationContext(store.getState());
        break;
    }

    return next(action);
});

/**
 * Registers listeners to the react-native-watch-connectivity lib.
 *
 * @param {Store} store - The redux store.
 * @private
 * @returns {void}
 */
function _appWillMount({ dispatch, getState }) {
    watch.subscribeToWatchState((error, watchState) => {
        if (error) {
            logger.error('Error getting watchState', error);

            return;
        }

        if (watchState.toLowerCase() === 'activated') {
            _updateApplicationContext(getState);
        }
    });

    watch.subscribeToMessages((error, message) => {
        if (error) {
            logger.error('watch.subscribeToMessages error:', error);

            return;
        }

        const {
            command,
            sessionID
        } = message;
        const currentSessionID = _getSessionId(getState());

        if (!sessionID || sessionID !== currentSessionID) {
            logger.warn(
                `Ignoring outdated watch command: ${message.command}`
                    + ` sessionID: ${sessionID} current session ID: ${currentSessionID}`);

            return;
        }

        switch (command) {
        case CMD_HANG_UP:
            if (typeof _getCurrentConferenceUrl(getState()) !== undefined) {
                dispatch(appNavigate(undefined));
            }
            break;
        case CMD_JOIN_CONFERENCE: {
            const newConferenceURL = message.data;
            const oldConferenceURL = _getCurrentConferenceUrl(getState());

            if (oldConferenceURL !== newConferenceURL) {
                dispatch(appNavigate(newConferenceURL));
            }
            break;
        }
        case CMD_SET_MUTED:
            dispatch(
                setAudioMuted(
                    message.muted === 'true',
                    /* ensureTrack */ true));
            break;
        }
    });
}

/**
 * Figures out what's the current conference URL which is supposed to indicate what conference is currently active.
 * When not currently in any conference and not trying to join any then the 'NULL' string value is returned.
 *
 * @param {Object|Function} stateful - Either the whole Redux state object or the Redux store's {@code getState} method.
 * @returns {string}
 * @private
 */
function _getCurrentConferenceUrl(stateful) {
    const state = toState(stateful);
    let currentUrl;

    if (isInviteURLReady(state)) {
        currentUrl = toURLString(getInviteURL(state));
    }

    // Check if the URL doesn't end with a slash
    if (currentUrl && currentUrl.substr(-1) === '/') {
        currentUrl = undefined;
    }

    return currentUrl ? currentUrl : undefined;
}

/**
 * Gets the current Apple Watch session's ID. A new session is started whenever the conference URL has changed. It is
 * used to filter out outdated commands which may arrive very later if the Apple Watch loses the connectivity.
 *
 * @param {Object|Function} stateful - Either the whole Redux state object or the Redux store's {@code getState} method.
 * @returns {number}
 * @private
 */
function _getSessionId(stateful) {
    const state = toState(stateful);

    return state['features/mobile/watchos'].sessionID;
}

/**
 * Gets the list of recent URLs to be passed over to the Watch app.
 *
 * @param {Object|Function} stateful - Either the whole Redux state object or the Redux store's {@code getState} method.
 * @returns {Array<Object>}
 * @private
 */
function _getRecentUrls(stateful) {
    const state = toState(stateful);
    const recentURLs = state['features/recent-list'];

    // Trim to MAX_RECENT_URLS and reverse the list
    const reversedList = recentURLs.slice(-MAX_RECENT_URLS);

    reversedList.reverse();

    return reversedList;
}

/**
 * Determines the audio muted state to be sent to the apple watch.
 *
 * @param {Object|Function} stateful - Either the whole Redux state object or the Redux store's {@code getState} method.
 * @returns {boolean}
 * @private
 */
function _isAudioMuted(stateful) {
    const state = toState(stateful);
    const { audio } = state['features/base/media'];

    return audio.muted;
}

/**
 * Sends the context to the watch os app. At the time of this writing it's the entire state of
 * the 'features/mobile/watchos' reducer.
 *
 * @param {Object|Function} stateful - Either the whole Redux state object or the Redux store's {@code getState} method.
 * @private
 * @returns {void}
 */
function _updateApplicationContext(stateful) {
    const state = toState(stateful);
    const { conferenceTimestamp, sessionID } = state['features/mobile/watchos'];

    try {
        watch.updateApplicationContext({
            conferenceTimestamp,
            conferenceURL: _getCurrentConferenceUrl(state),
            micMuted: _isAudioMuted(state),
            recentURLs: _getRecentUrls(state),
            sessionID
        });
    } catch (error) {
        logger.error('Failed to stringify or send the context', error);
    }
}
