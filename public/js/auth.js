// Sign-in screen: Email/Password, Google and Phone (SMS code).
import { auth } from './firebase.js';
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile,
  GoogleAuthProvider, signInWithPopup, RecaptchaVerifier, signInWithPhoneNumber, signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { BRAND, logoHtml, websiteUrl } from './brand.js';

export const signOut = () => fbSignOut(auth);

const messages = {
  'auth/invalid-credential': 'That email and password don\'t match.',
  'auth/wrong-password': 'That email and password don\'t match.',
  'auth/user-not-found': 'No account with that email. Choose "Create account".',
  'auth/email-already-in-use': 'There\'s already an account with that email. Sign in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/invalid-email': 'That email address doesn\'t look right.',
  'auth/invalid-phone-number': 'Enter the phone number with area code, like (586) 555-0100.',
  'auth/invalid-verification-code': 'That code isn\'t right. Check the text and try again.',
  'auth/popup-closed-by-user': 'The Google window was closed before signing in.',
  'auth/operation-not-allowed': 'This sign-in method isn\'t turned on yet in the Firebase console.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
};
const friendly = (e) => messages[e.code] || e.message;

// US numbers typed as (586) 555-0100 become +15865550100.
export function toE164(raw) {
  const s = String(raw).trim();
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return '+' + d;
}

export function renderSignIn(root) {
  root.innerHTML = `
  <div class="auth-wrap">
    <div class="card auth-card">
      <div class="auth-logo">${logoHtml()}</div>
      <p class="muted">Estimates, contracts, pay apps and invoices for storefront and shower jobs.</p>

      <button class="btn google" id="google"><span class="g">G</span> Continue with Google</button>

      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="email" role="tab">Email</button>
        <button class="tab" data-tab="phone" role="tab">Phone</button>
      </div>

      <form id="email-form" class="stack">
        <label>Email <input type="email" name="email" autocomplete="email" required></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" minlength="6" required></label>
        <label class="signup-only hidden">Your name <input name="name" autocomplete="name"></label>
        <button class="btn primary" type="submit" id="email-submit">Sign in</button>
        <div class="row between small">
          <a href="#" id="toggle-mode">Create account</a>
          <a href="#" id="reset">Forgot password?</a>
        </div>
      </form>

      <form id="phone-form" class="stack hidden">
        <label>Mobile number <input type="tel" name="phone" placeholder="(586) 555-0100" autocomplete="tel" required></label>
        <button class="btn primary" type="submit" id="phone-send">Text me a code</button>
        <div id="code-step" class="stack hidden">
          <label>6-digit code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>
          <button class="btn primary" type="button" id="phone-verify">Verify and sign in</button>
        </div>
        <div id="recaptcha"></div>
      </form>

      <p class="msg" id="auth-msg" role="alert"></p>
    </div>
    <p class="auth-foot">${BRAND.address}<br>Office ${BRAND.phone} · <a href="mailto:${BRAND.email}">${BRAND.email}</a> · <a href="${websiteUrl(BRAND.website)}" target="_blank" rel="noopener">${BRAND.website}</a></p>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const msg = (text, ok = false) => { $('#auth-msg').textContent = text; $('#auth-msg').className = 'msg ' + (ok ? 'ok' : 'err'); };
  const busy = (btn, on) => { btn.disabled = on; };

  root.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    root.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#email-form').classList.toggle('hidden', t.dataset.tab !== 'email');
    $('#phone-form').classList.toggle('hidden', t.dataset.tab !== 'phone');
    msg('');
  }));

  $('#google').addEventListener('click', async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { msg(friendly(e)); }
  });

  let signup = false;
  $('#toggle-mode').addEventListener('click', (e) => {
    e.preventDefault();
    signup = !signup;
    $('#email-submit').textContent = signup ? 'Create account' : 'Sign in';
    $('#toggle-mode').textContent = signup ? 'I already have an account' : 'Create account';
    root.querySelector('.signup-only').classList.toggle('hidden', !signup);
    $('#email-form [name=password]').autocomplete = signup ? 'new-password' : 'current-password';
  });

  $('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('#email-submit');
    busy(btn, true);
    try {
      if (signup) {
        const cred = await createUserWithEmailAndPassword(auth, f.get('email'), f.get('password'));
        if (f.get('name')) await updateProfile(cred.user, { displayName: f.get('name') });
      } else {
        await signInWithEmailAndPassword(auth, f.get('email'), f.get('password'));
      }
    } catch (err) { msg(friendly(err)); } finally { busy(btn, false); }
  });

  $('#reset').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = $('#email-form [name=email]').value;
    if (!email) return msg('Type your email above first, then click "Forgot password?".');
    try { await sendPasswordResetEmail(auth, email); msg(`Password reset email sent to ${email}.`, true); } catch (err) { msg(friendly(err)); }
  });

  let verifier = null;
  let confirmation = null;
  $('#phone-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#phone-send');
    busy(btn, true);
    try {
      verifier = verifier || new RecaptchaVerifier(auth, 'recaptcha', { size: 'invisible' });
      const number = toE164($('#phone-form [name=phone]').value);
      confirmation = await signInWithPhoneNumber(auth, number, verifier);
      $('#code-step').classList.remove('hidden');
      msg(`Code sent to ${number}.`, true);
      $('#phone-form [name=code]').focus();
    } catch (err) {
      msg(friendly(err));
      if (verifier) { verifier.clear(); verifier = null; $('#recaptcha').innerHTML = ''; }
    } finally { busy(btn, false); }
  });

  $('#phone-verify').addEventListener('click', async () => {
    const btn = $('#phone-verify');
    busy(btn, true);
    try { await confirmation.confirm($('#phone-form [name=code]').value.trim()); } catch (err) { msg(friendly(err)); } finally { busy(btn, false); }
  });
}
