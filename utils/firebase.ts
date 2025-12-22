import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signOut,
  signInAnonymously,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  Auth
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  addDoc,
  updateDoc,
  Timestamp,
  Firestore
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCGsYx0VAqEuNdY9SrHgj9WvX3nXqUZrYc",
  authDomain: "global-classroom-b4322.firebaseapp.com",
  projectId: "global-classroom-b4322",
  storageBucket: "global-classroom-b4322.firebasestorage.app",
  messagingSenderId: "322060753872",
  appId: "1:322060753872:web:4356b6646ccc324f15f7d5",
  measurementId: "G-4WPH84VZ32"
};

const app = initializeApp(firebaseConfig);

let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;

export const getAppAuth = (): Auth => {
  if (!authInstance) {
    authInstance = getAuth(app);
  }
  return authInstance;
};

export const getAppFirestore = (): Firestore => {
  if (!firestoreInstance) {
    firestoreInstance = getFirestore(app);
  }
  return firestoreInstance;
};

export const signInAsGuest = async () => {
  try {
    const auth = getAppAuth();
    const result = await signInAnonymously(auth);
    return result.user;
  } catch (error) {
    console.error("Guest login failed:", error);
    throw error;
  }
};

export const signUpWithEmailPassword = async (email: string, password: string) => {
  const auth = getAppAuth();
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
};

export const signInWithEmailPassword = async (email: string, password: string) => {
  const auth = getAppAuth();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
};

export const logOut = async () => {
  try {
    const auth = getAppAuth();
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed", error);
  }
};

// --- Firestore Functions ---

export const getUserProfile = async (uid: string) => {
  const db = getAppFirestore();
  const docRef = doc(db, "users", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data();
  }
  return null;
};

export const saveUserProfile = async (uid: string, data: any) => {
  const db = getAppFirestore();
  const docRef = doc(db, "users", uid);
  await setDoc(docRef, { ...data, updatedAt: Timestamp.now() }, { merge: true });
};

export default app;