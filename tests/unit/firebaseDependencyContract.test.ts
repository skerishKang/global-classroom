/**
 * Firebase dependency contract (#37).
 *
 * The owner decision for this app is KEEP Firebase (Auth + Firestore live
 * sharing), and #37 resolves production dependency advisories around it. This
 * test locks the exact API surface the app depends on — both as a type check
 * (it will not compile if a future firebase resolution drops or renames any
 * of these exports) and as runtime presence of the entry points the app
 * actually calls. No production Firebase code is touched and no network call
 * is made: the app is initialized with local fixture configuration only.
 */
import { describe, expect, test } from 'vitest';
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
    getAuth,
    onAuthStateChanged,
    signInAnonymously,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    type Auth,
} from 'firebase/auth';
import {
    getFirestore,
    doc,
    collection,
    onSnapshot,
    runTransaction,
    setDoc,
    updateDoc,
    deleteDoc,
    type Firestore,
} from 'firebase/firestore';

const requiredFunctions: Record<string, Function> = {
    // Auth contract (utils/firebase.ts + hooks/useAuth.ts)
    initializeApp,
    getApps,
    getApp,
    getAuth,
    onAuthStateChanged,
    signInAnonymously,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    // Firestore contract (hooks/useLiveSharing.ts — #33 territory, API only)
    getFirestore,
    doc,
    collection,
    onSnapshot,
    runTransaction,
    setDoc,
    updateDoc,
    deleteDoc,
};

describe('firebase dependency contract (#37)', () => {
  test('every Auth/Firestore entry point the app uses still exists', () => {
    for (const [name, fn] of Object.entries(requiredFunctions)) {
      expect(typeof fn, name).toBe('function');
    }
  });

  test('local fixture initialization keeps Auth and Firestore types resolvable', () => {
    // Fake config: initializeApp is local-only, nothing contacts production.
    const app: FirebaseApp = initializeApp({
        apiKey: 'contract-test-key',
        authDomain: 'contract-test.firebaseapp.com',
        projectId: 'contract-test',
        appId: '1:0:web:contract',
    }, 'dependency-contract-test');
    expect(app.name).toBe('dependency-contract-test');

    const auth: Auth = getAuth(app);
    expect(auth).toBeTruthy();
    const db: Firestore = getFirestore(app);
    expect(db).toBeTruthy();

    // The Firestore reference helpers used by live sharing must accept the
    // resolved shapes (compile-time proof that signatures survived the bump).
    const roomRef = doc(collection(db, 'rooms'), 'room-1');
    expect(roomRef.id).toBe('room-1');
    expect(typeof onSnapshot).toBe('function');
    expect(typeof runTransaction).toBe('function');
  });
});
