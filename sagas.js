import {take, takeEvery, takeLatest, takeLeading, call, put, fork, cancel, select, race} from 'redux-saga/effects';
import * as actions from '../actions';
import {
  CREATE_USER,
  LOGIN,
  NAVIGATOR_LOADED,
  SYNC_USER,
  SET_USER,
  FETCH_CURRENT_EVENT,
  SET_CURRENT_EVENT,
  FETCH_CURRENT_ROUTE,
  SET_CURRENT_ROUTE,
  SYNC_CURRENT_POSITIONS,
  STOP_SYNC_CURRENT_POSITIONS,
  SYNC_EVENTS,
  STOP_SYNC_EVENTS,
  LOGOUT,
  SET_USER_CREDENTIALS,
  START_TRACKING,
  STOP_TRACKING,
  SET_CURRENT_LOCATION,
  SET_CURRENT_NAVIGATION_STATE,
} from '../actions/types';
import * as NavigationService from '../../services/NavigationService.js';
import firebase from '@react-native-firebase/app';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import storage from '@react-native-firebase/storage';
import analytics from '@react-native-firebase/analytics';
import ReduxSagaFirebase from 'redux-saga-firebase';
const reduxSagaFirebase = new ReduxSagaFirebase(firebase);
import RNFetchBlob from 'rn-fetch-blob';
import * as RNFS from 'react-native-fs';



function* createUser(action){
  try{
    const { email, password, firstName, lastName } = action.payload;
    const credentials = yield call([auth(), auth().createUserWithEmailAndPassword], email, password);
    yield put({type: SET_USER_CREDENTIALS, payload: {credentials}});
    const newUserInfo = {email, firstName, lastName}
    yield call(reduxSagaFirebase.firestore.setDocument, `users/${credentials.user.uid}`, newUserInfo);
    yield put({type: SET_USER, payload: {uid: credentials.user.uid, ...newUserInfo}});
  }catch(e){
    console.log("createUserWorker error! => ", e);
    // yield put(actions.usersError({
    //     error: 'An error occurred when trying to create the user'
    // }));
  }
}

function* createUserWatcher(){
  yield takeLatest(CREATE_USER, createUser);
}


function* login(action){
	try{
    const { email, password } = action.payload;
    const credentials = yield call([auth(), auth().signInWithEmailAndPassword], email, password);
    yield put({type: SET_USER_CREDENTIALS, payload: {credentials}});
    yield put({type: SET_USER, payload: {uid: credentials.user.uid}});
	}catch(e){
    console.log("login error! => ", e);
	}
}

function* loginWatcher(){
	yield takeLatest(LOGIN, login);
}


function* logout(){
  try{
    yield call(NavigationService.navigate, 'welcome');
  }catch(e){
    console.log("logout error! => ", e);
  }
}

function* logoutWatcher(){
  yield takeLeading(LOGOUT, logout);
}


function* broadcastLocation(action){
  let { location } = action.payload;
  const uid = yield select((state) => state.user.credentials.user.uid);
  const eventId = yield select((state) => state.current.event.id);
  const routeId = yield select((state) => state.current.route.id);
  if(uid && eventId !== '' && routeId !== ''){
    location.eventId = eventId;
    location.routeId = routeId;
    firestore().collection('currentPositions').doc(uid).set(location);
  }
}

function* setCurrentLocationWatcher(){
  yield takeEvery(SET_CURRENT_LOCATION, broadcastLocation);
}


function* startTracking(action){
	try{
    const { uid, eventId, routeId } = action.payload;
    const BackgroundGeolocation = yield select((state) => state.tracking.BackgroundGeolocation);
    yield call(BackgroundGeolocation.start);
    console.log("- BackgroundGeolocation has been started!");
    yield race([
      take(STOP_TRACKING),
      take(LOGOUT)
    ]);
    console.log("turning BackgroundGeolocation off...");
    yield call(BackgroundGeolocation.stop);
    console.log("deleting currentPositions listing...");
    firestore().collection('currentPositions').doc(uid).delete();
	}catch(e){
    console.log("startTracking error! => ", e);
	} finally {
    console.log("end of tracking saga.");
  }
}

function* startTrackingWatcher(){
	yield takeLeading(START_TRACKING, startTracking);
}


function* setUser(action){
  try{
    const { uid } = action.payload;
    yield put({type: SYNC_USER, uid});
    yield call([analytics(), analytics().setUserId], uid);
    // if navigator hasn't been loaded yet, wait for it to be loaded so that we can navigate
    const navigatorLoaded = yield select((state) => state.navigation.navigatorLoaded);
    if(navigatorLoaded === false){
      yield take(NAVIGATOR_LOADED);
    }
    const eventId = yield select((state) => state.current.event.id);
    const routeId = yield select((state) => state.current.route.id);
    if(eventId !== '' && routeId !== ''){
      yield call(NavigationService.navigate, 'map');
      yield put({type: START_TRACKING, payload: {uid, eventId, routeId}});
    } else {
      yield call(NavigationService.navigate, 'eventsIndex');
    }
  } catch(e){
    console.log("setUser error! => ", e);
  }
}

function* setUserWatcher(){
  yield takeLeading(SET_USER, setUser);
}


function* syncUser({uid}){
  try{
    const task = yield fork(reduxSagaFirebase.firestore.syncDocument, `users/${uid}`, 
      { 
        successActionCreator: actions.setUserInfo,
        transform: (payload) => {
          const userInfo = payload.data();
          return userInfo;
        }
      }
    );
    yield take(LOGOUT);
    yield cancel(task);
  } catch(e) {
    console.log("syncUser error! => ". e);
  }
}

function* syncUserWatcher(){
  yield takeLeading(SYNC_USER, syncUser);
}


function* syncCurrentPositions(action){
  try{
    const { eventId, routeId } = action.payload;
    const task = yield fork(
      reduxSagaFirebase.firestore.syncCollection, 
        firestore().collection(`currentPositions`)
          .where("eventId", "==", eventId)
          .where("routeId", "==", routeId), 
      { 
        successActionCreator: actions.setCurrentPositions,
        transform: (querySnapshot) => {
          const positions = querySnapshot.docs.map((doc)=>{return {id: doc.id, ...doc.data()}});
          return positions
        }
      }
    );
    const {stopSyncCurrentPositions, logout} = yield race({
      stopSyncCurrentPositions: take(STOP_SYNC_CURRENT_POSITIONS),
      logout: take(LOGOUT)
    });
    if(stopSyncCurrentPositions || logout){
      console.log("cancelling syncCurrentPositions...");
      yield cancel(task);
    }
  } catch(e) {
    console.log("syncCurrentPositions error! => ". e);
  }
}

function* syncCurrentPositionsWatcher(){
  yield takeLeading(SYNC_CURRENT_POSITIONS, syncCurrentPositions);
}


function* fetchCurrentEvent(action){
  try{
    const { eventId } = action.payload;
    const doc = yield call(reduxSagaFirebase.firestore.getDocument, `events/${eventId}`);
    const event = {id: doc.id, ...doc.data()};
    yield put({type: SET_CURRENT_EVENT, payload: event});
    yield call(NavigationService.navigate, 'event', {eventId});

  } catch(e) { 
    console.log("fetchCurrentEvent error! => ", e);
  }
}

function* fetchCurrentEventWatcher(){
  yield takeLeading(FETCH_CURRENT_EVENT, fetchCurrentEvent);
}


function* fetchCurrentRoute(action){
  try{
    yield call(NavigationService.navigate, 'map');
    const { uid, eventId, routeId } = action.payload;
    const doc = yield call(reduxSagaFirebase.firestore.getDocument, `events/${eventId}/routes/${routeId}`);
    const route = {id: doc.id, ...doc.data()};
    const routesStorage = firebase.app().storage('gs://proxium_routes');
    const routesStorageRef = routesStorage.ref(route.routeDataStoragePath);
    const routeDataURL = yield call([routesStorageRef, routesStorageRef.getDownloadURL]);
    const fetchRouteResponse = yield call(RNFetchBlob.config({fileCache : true}).fetch, 'GET', routeDataURL);
    const routeFilePath = fetchRouteResponse.path();
    const routeDataString = yield call(RNFS.readFile, routeFilePath);
    const routeData = yield call(JSON.parse, routeDataString);
    route.routeData = routeData;
    yield put({type: SET_CURRENT_ROUTE, payload: route});
    // resync for new current event and route
    yield put({type: STOP_SYNC_CURRENT_POSITIONS});
    yield put({type: SYNC_CURRENT_POSITIONS, payload: {eventId, routeId}});
    yield put({type: START_TRACKING, payload: {uid, eventId, routeId}});
  } catch(e) {
    console.log("fetchCurrentRoute error! => ". e);
  }
}

function* fetchCurrentRouteWatcher(){
  yield takeLeading(FETCH_CURRENT_ROUTE, fetchCurrentRoute);
}


function* syncEvents(){
  try{
    const task = yield fork(
      reduxSagaFirebase.firestore.syncCollection, 
      'events',
      { 
        successActionCreator: actions.setEvents,
        transform: (querySnapshot) => {
          const events = querySnapshot.docs.map((doc)=>{return {id: doc.id, ...doc.data()}});
          return events
        }
      }
    );
    const {stopSyncEvents, logout} = yield race({
      stopSyncEvents: take(STOP_SYNC_EVENTS),
      logout: take(LOGOUT)
    });
    if(stopSyncEvents || logout){
      console.log("cancelling syncEvents...");
      yield cancel(task);
    }
  } catch(e) {
    console.log("syncEvents error! => ". e);
  }
}

function* syncEventsWatcher(){
  yield takeLeading(SYNC_EVENTS, syncEvents);
}


function* setCurrentNavigationState(action){
  try{
    const currentScreen = action.payload;
    yield call([analytics(), analytics().setCurrentScreen], currentScreen, 'App');
  } catch(e){
    console.log("setCurrentNavigation error! => ", e);
  }
}

function* setCurrentNavigationStateWatcher(){
  yield takeEvery(SET_CURRENT_NAVIGATION_STATE, setCurrentNavigationState)
}




const sagas = [
  fork(createUserWatcher),
  fork(loginWatcher),
  fork(logoutWatcher),
  fork(startTrackingWatcher),
  fork(setUserWatcher),
  fork(syncUserWatcher),
  fork(syncCurrentPositionsWatcher),
  fork(syncEventsWatcher),
  fork(fetchCurrentEventWatcher),
  fork(fetchCurrentRouteWatcher),
  fork(setCurrentLocationWatcher),
  fork(setCurrentNavigationStateWatcher),
];

export default sagas;