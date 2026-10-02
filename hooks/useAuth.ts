import { useState, useEffect, useRef } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import {
    getAppAuth,
    logOut,
    signInAsGuest,
    signInWithEmailPassword,
    signUpWithEmailPassword
} from '../utils/firebase';
import {
    GOOGLE_CLIENT_ID,
    GOOGLE_SCOPES,
    GOOGLE_USER_STORAGE_KEY,
    ACCESS_TOKEN_STORAGE_KEY,
    ADMIN_EMAIL
} from '../constants';

export function useAuth(enabled: boolean = true) {
    const [user, setUser] = useState<User | any | null>(() => {
        try {
            const raw = sessionStorage.getItem(GOOGLE_USER_STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    });
    const [accessToken, setAccessToken] = useState<string | null>(() => {
        try {
            return sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
        } catch {
            return null;
        }
    });

    const [emailAuthEmail, setEmailAuthEmail] = useState('');
    const [emailAuthPassword, setEmailAuthPassword] = useState('');
    const [emailAuthError, setEmailAuthError] = useState<string>('');
    const [isEmailAuthBusy, setIsEmailAuthBusy] = useState(false);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
    const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);

    const tokenClientRef = useRef<any>(null);
    const isGuestSigningInRef = useRef(false);

    const userEmail = typeof (user as any)?.email === 'string' ? String((user as any).email) : '';
    const isAdmin = userEmail.toLowerCase() === ADMIN_EMAIL;

    // 1. Initialize GIS Client
    useEffect(() => {
        if (!enabled) return;
        const checkGoogle = setInterval(() => {
            if (typeof (window as any).google !== 'undefined' && (window as any).google.accounts && (window as any).google.accounts.oauth2) {
                if (!GOOGLE_CLIENT_ID) {
                    console.error('GOOGLE_CLIENT_ID is empty.');
                    clearInterval(checkGoogle);
                    return;
                }

                try {
                    tokenClientRef.current = (window as any).google.accounts.oauth2.initTokenClient({
                        client_id: GOOGLE_CLIENT_ID,
                        scope: GOOGLE_SCOPES,
                        callback: async (tokenResponse: any) => {
                            if (tokenResponse && tokenResponse.access_token) {
                                setAccessToken(tokenResponse.access_token);
                                try {
                                    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                                        headers: { 'Authorization': `Bearer ${tokenResponse.access_token}` }
                                    });
                                    const profile = await res.json();
                                    const googleUser = {
                                        uid: profile.sub,
                                        displayName: profile.name,
                                        email: profile.email,
                                        photoURL: profile.picture,
                                        isAnonymous: false,
                                        providerId: 'google.com'
                                    };
                                    setUser(googleUser);
                                    sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, tokenResponse.access_token);
                                    sessionStorage.setItem(GOOGLE_USER_STORAGE_KEY, JSON.stringify(googleUser));
                                    setIsLoginModalOpen(false);
                                } catch (e) {
                                    console.error("Failed to fetch Google profile", e);
                                }
                            }
                        },
                    });
                    clearInterval(checkGoogle);
                } catch (e) {
                    console.error('initTokenClient failed:', e);
                    tokenClientRef.current = null;
                }
            }
        }, 500);

        return () => clearInterval(checkGoogle);
    }, [enabled]);

    // 2. Monitor Firebase Auth State
    useEffect(() => {
        if (!enabled) {
            setIsAuthReady(true);
            return;
        }
        const auth = getAppAuth();
        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
            setIsAuthReady(true);
            setUser((prev) => {
                if (accessToken && prev && !prev.isAnonymous) return prev;

                if (!firebaseUser) {
                    if (!accessToken && (!prev || prev.isAnonymous) && !isGuestSigningInRef.current) {
                        isGuestSigningInRef.current = true;
                        signInAsGuest()
                            .then(() => {
                                const current = getAppAuth().currentUser;
                                if (current?.isAnonymous) setUser(current);
                            })
                            .catch(e => console.error('Guest login failed:', e))
                            .finally(() => isGuestSigningInRef.current = false);
                    }
                    return prev || null;
                }
                isGuestSigningInRef.current = false;
                return firebaseUser;
            });
        });
        return () => unsubscribe();
    }, [accessToken, enabled]);

    const handleEmailLogin = async () => {
        if (isEmailAuthBusy) return;
        setEmailAuthError('');
        if (!emailAuthEmail.trim() || !emailAuthPassword) {
            setEmailAuthError('이메일과 비밀번호를 입력해주세요.');
            return;
        }
        setIsEmailAuthBusy(true);
        try {
            const firebaseUser = await signInWithEmailPassword(emailAuthEmail.trim(), emailAuthPassword);
            setAccessToken(null);
            sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
            sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
            setUser(firebaseUser);
            setIsLoginModalOpen(false);
            setEmailAuthPassword('');
        } catch (e) {
            setEmailAuthError(`로그인 실패: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setIsEmailAuthBusy(false);
        }
    };

    const handleEmailSignUp = async () => {
        if (isEmailAuthBusy) return;
        setEmailAuthError('');
        if (!emailAuthEmail.trim() || !emailAuthPassword) {
            setEmailAuthError('이메일과 비밀번호를 입력해주세요.');
            return;
        }
        setIsEmailAuthBusy(true);
        try {
            const firebaseUser = await signUpWithEmailPassword(emailAuthEmail.trim(), emailAuthPassword);
            setAccessToken(null);
            sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
            sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
            setUser(firebaseUser);
            setIsLoginModalOpen(false);
            setEmailAuthPassword('');
        } catch (e) {
            setEmailAuthError(`가입 실패: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setIsEmailAuthBusy(false);
        }
    };

    const handleLoginSelection = async (type: 'google' | 'guest') => {
        setEmailAuthError('');
        if (type === 'google') {
            if (!tokenClientRef.current) {
                alert("Google Auth 초기화 중입니다. 잠시 후 쇼하세요.");
                return;
            }
            tokenClientRef.current.requestAccessToken();
        } else {
            try {
                const auth = getAppAuth();
                const current = auth.currentUser;
                const guest = current?.isAnonymous ? current : await signInAsGuest();
                setAccessToken(null);
                sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
                sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
                setUser(guest);
            } catch (e) {
                console.error('Guest login failed', e);
            }
            setIsLoginModalOpen(false);
        }
    };

    const handleLogout = async () => {
        setEmailAuthError('');
        if (accessToken) {
            if (typeof (window as any).google !== 'undefined' && (window as any).google.accounts?.oauth2) {
                (window as any).google.accounts.oauth2.revoke(accessToken, () => console.log('Token revoked'));
            }
            setAccessToken(null);
        }
        await logOut();
        sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
        setUser(null);
        setIsProfileMenuOpen(false);
    };

    return {
        user,
        accessToken,
        isAdmin,
        isAuthReady,
        isLoginModalOpen,
        setIsLoginModalOpen,
        isProfileMenuOpen,
        setIsProfileMenuOpen,
        emailAuthEmail,
        setEmailAuthEmail,
        emailAuthPassword,
        setEmailAuthPassword,
        emailAuthError,
        setEmailAuthError,
        isEmailAuthBusy,
        handleEmailLogin,
        handleEmailSignUp,
        handleLoginSelection,
        handleLogout
    };
}
