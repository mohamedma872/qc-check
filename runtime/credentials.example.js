'use strict';

// Template for the QC test account.
//
// SETUP: copy this file to the host repo root under the name in
// `credentialsFile` in qc.config.json (default `qc.credentials.js`):
//
//   cp runtime/credentials.example.js qc.credentials.js
//
// This template is committed; the copy is NOT. Add the real filename to
// .gitignore and keep it there. Never put real values in this file, never
// print them, never paste them into a report, a ticket comment or a log.
// Use a throwaway QC account with the access a QC run needs, not a personal
// login.
//
// One block per environment, keyed the same as `backend.baseUrls` in
// qc.config.json. `env` says which block to use when neither --env nor QC_ENV
// is given and backend.defaultEnv does not resolve.
// The field names here are fixed (`username`, `password`); which body fields
// they are sent as is set by backend.auth.usernameField / passwordField.
module.exports = {
  env: 'staging',
  staging: {
    username: 'CHANGE_ME', // QC account login (national id, email, phone - whatever the backend expects)
    password: 'CHANGE_ME',
  },
  // production: { username: 'CHANGE_ME', password: 'CHANGE_ME' },
};
