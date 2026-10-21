// Which Firebase project this build talks to.
//
// These values are public by design — they identify the project, they do not
// authorise anything. What protects the data is firestore.rules and
// storage.rules, not the secrecy of this file.
//
// It is kept separate from index.html so that switching between the test
// project and production is one file, not an edit buried in the page where it
// is easy to ship the wrong one by accident.
//
// This is the TEST project. Production is turboflow-7b3ca; its values are in
// the comment at the bottom rather than in a second file, so there is only ever
// one of these to get wrong.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAa2xUoMWrVjNGYEmrRfzBy8CKQRC8NhK8",
  authDomain: "turboflow-test.firebaseapp.com",
  projectId: "turboflow-test",
  storageBucket: "turboflow-test.firebasestorage.app",
  messagingSenderId: "653114694502",
  appId: "1:653114694502:web:eda3415165a0335f7d86a7",
};

// Production — turboflow-7b3ca:
//   apiKey:            (in the production copy of this file, not here)
//   authDomain:        "turboflow-7b3ca.firebaseapp.com"
//   projectId:         "turboflow-7b3ca"
//   storageBucket:     "turboflow-7b3ca.firebasestorage.app"
//   messagingSenderId: "659747979647"
//   appId:             "1:659747979647:web:e718597ad69cd2b7311a4a"
