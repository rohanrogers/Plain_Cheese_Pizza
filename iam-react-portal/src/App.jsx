import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  Lock, 
  Mail, 
  User, 
  CheckCircle, 
  AlertTriangle, 
  Key, 
  LogOut, 
  Users, 
  FileText, 
  DollarSign, 
  Layers, 
  Smartphone, 
  RefreshCw,
  Building,
  CreditCard,
  ChevronRight
} from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

export default function App() {
  // Auth state
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('login'); // 'login' | 'signup' | 'forgot' | '2fa' | 'reset-password'
  
  // Login / Signup Form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  
  // 2FA Form
  const [otpToken, setOtpToken] = useState('');
  const [qrCode, setQrCode] = useState('');
  
  // Reset Password Form
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  
  // Notification / Alert
  const [notification, setNotification] = useState({ type: '', text: '' });
  
  // Portal Data
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminFinancials, setAdminFinancials] = useState(null);
  const [staffPipeline, setStaffPipeline] = useState(null);
  const [customerData, setCustomerData] = useState(null);

  // Staff Form
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [newStaffPassword, setNewStaffPassword] = useState('');
  const [newStaffName, setNewStaffName] = useState('');

  // Check auth on load
  useEffect(() => {
    checkAuth();
  }, []);

  const showNotice = (type, text) => {
    setNotification({ type, text });
    setTimeout(() => setNotification({ type: '', text: '' }), 7000);
  };

  const checkAuth = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCurrentUser(data.user);
        loadPortalData(data.user.role);
      } else {
        setCurrentUser(null);
      }
    } catch (e) {
      setCurrentUser(null);
    } finally {
      setLoading(false);
    }
  };

  const loadPortalData = async (role) => {
    if (role === 'ADMIN') {
      fetchAdminData();
    } else if (role === 'STAFF') {
      fetchStaffData();
    } else if (role === 'CUSTOMER') {
      fetchCustomerData();
    }
  };

  const fetchAdminData = async () => {
    try {
      const [usersRes, finRes] = await Promise.all([
        fetch(`${API_BASE}/users/admin/users`, { credentials: 'include' }),
        fetch(`${API_BASE}/users/admin/financials`, { credentials: 'include' })
      ]);
      if (usersRes.ok) {
        const u = await usersRes.json();
        setAdminUsers(u.users);
      }
      if (finRes.ok) {
        const f = await finRes.json();
        setAdminFinancials(f);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchStaffData = async () => {
    try {
      const res = await fetch(`${API_BASE}/users/staff/pipeline`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setStaffPipeline(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchCustomerData = async () => {
    try {
      const res = await fetch(`${API_BASE}/users/customer/my-portal`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCustomerData(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // 1. Handle Signup
  const handleSignup = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name: fullName, company_name: companyName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showNotice('success', 'Account registered! Please log in to complete 2FA.');
      setView('login');
      setPassword('');
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // 2. Handle Login Step 1
  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.require2FA) {
        setQrCode(data.qrCode);
        setView('2fa');
        showNotice('info', 'Credentials valid! 6-digit OTP code dispatched to console/email & Authenticator.');
      }
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // 3. Handle 2FA Verification
  const handleVerify2FA = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/auth/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: otpToken })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setCurrentUser(data.user);
      loadPortalData(data.user.role);
      showNotice('success', `Welcome back, ${data.user.full_name || data.user.email}!`);
      setOtpToken('');
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // 4. Handle Logout
  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
      setCurrentUser(null);
      setView('login');
      setEmail('');
      setPassword('');
      showNotice('info', 'Logged out successfully.');
    } catch (err) {
      showNotice('error', 'Logout error');
    }
  };

  // 5. Handle Forgot Password
  const handleForgotPassword = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      showNotice('info', data.message);
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // 6. Handle Reset Password
  const handleResetPassword = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, email, newPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showNotice('success', data.message);
      setView('login');
      setPassword('');
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // 7. Admin provision staff
  const handleProvisionStaff = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/users/admin/provision-staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: newStaffEmail, password: newStaffPassword, full_name: newStaffName })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showNotice('success', data.message);
      setNewStaffEmail('');
      setNewStaffPassword('');
      setNewStaffName('');
      fetchAdminData();
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // 8. Staff record payment
  const handleRecordPayment = async (invoiceId, amount) => {
    try {
      const res = await fetch(`${API_BASE}/users/staff/record-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          invoice_id: invoiceId,
          amount,
          method: 'Bank Transfer',
          note: 'Logged by Internal Staff'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      showNotice('success', data.message);
      fetchStaffData();
    } catch (err) {
      showNotice('error', err.message);
    }
  };

  // Fast demo filler
  const fillCredentials = (userEmail, userPass) => {
    setEmail(userEmail);
    setPassword(userPass);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Shield className="w-6 h-6 text-white" />
          </div>
          <div>
            <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              Brightloop
            </span>
            <span className="text-xs text-slate-400 block font-medium">IAM & Subscription Cloud</span>
          </div>
        </div>

        {currentUser && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <span className="text-sm font-semibold text-slate-200 block">{currentUser.full_name || currentUser.email}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold uppercase ${
                currentUser.role === 'ADMIN' ? 'bg-purple-900/60 text-purple-300 border border-purple-500/30' :
                currentUser.role === 'STAFF' ? 'bg-amber-900/60 text-amber-300 border border-amber-500/30' :
                'bg-emerald-900/60 text-emerald-300 border border-emerald-500/30'
              }`}>
                {currentUser.role}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 rounded-lg bg-slate-800 hover:bg-red-500/10 hover:text-red-400 text-slate-400 transition"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        )}
      </header>

      {/* Global Alert / Toast */}
      {notification.text && (
        <div className={`mx-6 mt-4 p-4 rounded-xl flex items-center gap-3 border shadow-lg ${
          notification.type === 'error' ? 'bg-red-950/80 border-red-800 text-red-200' :
          notification.type === 'success' ? 'bg-emerald-950/80 border-emerald-800 text-emerald-200' :
          'bg-blue-950/80 border-blue-800 text-blue-200'
        }`}>
          {notification.type === 'error' ? <AlertTriangle className="w-5 h-5 flex-shrink-0" /> : <CheckCircle className="w-5 h-5 flex-shrink-0" />}
          <span className="text-sm font-medium">{notification.text}</span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {!currentUser ? (
          /* Authentication Screens */
          <div className="max-w-md mx-auto my-12 bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur">
            {/* Quick Demo Credentials Bar */}
            <div className="mb-6 p-3 bg-slate-800/80 rounded-xl border border-slate-700/60 text-xs">
              <span className="font-semibold text-slate-300 block mb-2">⚡ Quick Autofill Demo Credentials:</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fillCredentials('admin@brightloop.io', 'Admin@12345!')}
                  className="px-2 py-1 rounded bg-purple-950 border border-purple-700/50 text-purple-300 hover:bg-purple-900 transition"
                >
                  Admin
                </button>
                <button
                  type="button"
                  onClick={() => fillCredentials('staff@brightloop.io', 'Staff@12345!')}
                  className="px-2 py-1 rounded bg-amber-950 border border-amber-700/50 text-amber-300 hover:bg-amber-900 transition"
                >
                  Internal Staff
                </button>
                <button
                  type="button"
                  onClick={() => fillCredentials('cust@company.com', 'Customer@12345!')}
                  className="px-2 py-1 rounded bg-emerald-950 border border-emerald-700/50 text-emerald-300 hover:bg-emerald-900 transition"
                >
                  Customer
                </button>
              </div>
            </div>

            {view === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="text-center mb-6">
                  <h2 className="text-2xl font-bold text-white">Sign In to Brightloop</h2>
                  <p className="text-xs text-slate-400 mt-1">Multi-device protection & session IDOR immunity</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Email Address</label>
                  <div className="relative">
                    <Mail className="w-4 h-4 absolute left-3 top-3 text-slate-500" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@company.com"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-10 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Password</label>
                  <div className="relative">
                    <Lock className="w-4 h-4 absolute left-3 top-3 text-slate-500" />
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-10 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
                  <button
                    type="button"
                    onClick={() => setView('forgot')}
                    className="hover:text-blue-400 transition"
                  >
                    Forgot password?
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('signup')}
                    className="hover:text-blue-400 transition font-semibold"
                  >
                    Create account
                  </button>
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition shadow-lg shadow-blue-600/30"
                >
                  Proceed to 2FA Verification
                </button>
              </form>
            )}

            {view === 'signup' && (
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="text-center mb-6">
                  <h2 className="text-2xl font-bold text-white">Create Customer Account</h2>
                  <p className="text-xs text-slate-400 mt-1">Strict password enforcement (&gt;8 chars, upper, lower, special)</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Doe"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Company Name</label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Acme Corp"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Work Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@company.com"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Must not be your email, 8+ chars, upper, lower, special"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-[11px] text-slate-400 mt-1 block">
                    Security Rule: Password cannot match or contain your email address.
                  </span>
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition shadow-lg shadow-blue-600/30"
                >
                  Register Account
                </button>

                <div className="text-center text-xs text-slate-400 pt-2">
                  Already registered?{' '}
                  <button type="button" onClick={() => setView('login')} className="text-blue-400 font-semibold hover:underline">
                    Sign in
                  </button>
                </div>
              </form>
            )}

            {view === '2fa' && (
              <form onSubmit={handleVerify2FA} className="space-y-4">
                <div className="text-center mb-6">
                  <div className="w-12 h-12 bg-blue-600/20 text-blue-400 rounded-full flex items-center justify-center mx-auto mb-2 border border-blue-500/30">
                    <Smartphone className="w-6 h-6" />
                  </div>
                  <h2 className="text-2xl font-bold text-white">2-Factor Authentication</h2>
                  <p className="text-xs text-slate-400 mt-1">Enter the 6-digit code from your Authenticator app or Email OTP</p>
                </div>

                {qrCode && (
                  <div className="text-center p-3 bg-white rounded-xl max-w-[200px] mx-auto shadow-inner">
                    <img src={qrCode} alt="TOTP QR Code" className="w-full h-auto mx-auto" />
                    <p className="text-[10px] text-slate-700 font-mono mt-1">Scan with Google Authenticator / Authy</p>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Enter 6-Digit OTP Code</label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={otpToken}
                    onChange={(e) => setOtpToken(e.target.value)}
                    placeholder="123456"
                    className="w-full text-center tracking-widest font-mono text-2xl font-bold bg-slate-950 border border-slate-800 rounded-xl py-3 focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-[11px] text-slate-400 text-center block mt-1">
                    (Tip: Check backend console if SMTP credentials are in local dev mode)
                  </span>
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition shadow-lg shadow-blue-600/30"
                >
                  Verify & Enter Portal
                </button>

                <div className="text-center text-xs text-slate-400 pt-1">
                  <button type="button" onClick={() => setView('login')} className="hover:text-slate-200">
                    Cancel and return to login
                  </button>
                </div>
              </form>
            )}

            {view === 'forgot' && (
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div className="text-center mb-6">
                  <h2 className="text-2xl font-bold text-white">Reset Password</h2>
                  <p className="text-xs text-slate-400 mt-1">Enter your email and we'll dispatch a secure reset link</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Account Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition shadow-lg shadow-blue-600/30"
                >
                  Send Reset Link
                </button>

                <div className="flex justify-between text-xs text-slate-400 pt-2">
                  <button type="button" onClick={() => setView('reset-password')} className="text-blue-400 hover:underline">
                    Have a reset token? Click here
                  </button>
                  <button type="button" onClick={() => setView('login')} className="hover:text-slate-200">
                    Back to login
                  </button>
                </div>
              </form>
            )}

            {view === 'reset-password' && (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div className="text-center mb-6">
                  <h2 className="text-2xl font-bold text-white">Set New Password</h2>
                  <p className="text-xs text-slate-400 mt-1">Provide your token and choose a compliant password</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Reset Token</label>
                  <input
                    type="text"
                    required
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    placeholder="Paste 64-char token from email"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">New Password</label>
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Must satisfy policy and not be your email"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition shadow-lg shadow-emerald-600/30"
                >
                  Save New Password
                </button>

                <div className="text-center text-xs text-slate-400 pt-1">
                  <button type="button" onClick={() => setView('login')} className="hover:text-slate-200">
                    Back to login
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          /* ========================================================= */
          /* THREE DISTINCT ROLE-BASED PORTALS                         */
          /* ========================================================= */
          <div className="space-y-8">
            {/* PORTAL 1: ADMIN CONTROL CENTER */}
            {currentUser.role === 'ADMIN' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-extrabold text-white flex items-center gap-3">
                      <span className="p-2 bg-purple-600/20 text-purple-400 rounded-xl border border-purple-500/30">
                        <Shield className="w-7 h-7" />
                      </span>
                      Administrator Control Hub
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Full system control, staff provisioning & financial oversight</p>
                  </div>
                  <button
                    onClick={fetchAdminData}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                  </button>
                </div>

                {/* KPI Metrics */}
                {adminFinancials && (
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl">
                      <span className="text-xs text-slate-400 font-medium">Active Subscriptions</span>
                      <p className="text-2xl font-bold text-white mt-1">{adminFinancials.activeSubscriptions}</p>
                    </div>
                    <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl">
                      <span className="text-xs text-slate-400 font-medium">Monthly Recurring Revenue (MRR)</span>
                      <p className="text-2xl font-bold text-purple-400 mt-1">${(adminFinancials.totalMRR || 0).toFixed(2)}</p>
                    </div>
                    <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl">
                      <span className="text-xs text-slate-400 font-medium">Total Invoiced</span>
                      <p className="text-2xl font-bold text-blue-400 mt-1">${(adminFinancials.totalInvoiced || 0).toFixed(2)}</p>
                    </div>
                    <div className="p-5 bg-slate-900 border border-slate-800 rounded-2xl">
                      <span className="text-xs text-slate-400 font-medium">Total Cash Collected</span>
                      <p className="text-2xl font-bold text-emerald-400 mt-1">${(adminFinancials.totalCollected || 0).toFixed(2)}</p>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Provision Staff Form */}
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                      <User className="w-5 h-5 text-purple-400" />
                      Provision Internal Staff
                    </h3>
                    <p className="text-xs text-slate-400 mb-4">
                      Only administrators can add internal staff members to Brightloop.
                    </p>
                    <form onSubmit={handleProvisionStaff} className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1">Staff Member Name</label>
                        <input
                          type="text"
                          required
                          value={newStaffName}
                          onChange={(e) => setNewStaffName(e.target.value)}
                          placeholder="Sarah Jenkins"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1">Staff Work Email</label>
                        <input
                          type="email"
                          required
                          value={newStaffEmail}
                          onChange={(e) => setNewStaffEmail(e.target.value)}
                          placeholder="sarah@brightloop.io"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400 mb-1">Initial Password</label>
                        <input
                          type="password"
                          required
                          value={newStaffPassword}
                          onChange={(e) => setNewStaffPassword(e.target.value)}
                          placeholder="StaffPass123!#"
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                        />
                      </div>
                      <button
                        type="submit"
                        className="w-full py-2.5 px-4 bg-purple-600 hover:bg-purple-500 text-white font-semibold rounded-xl transition text-sm shadow-lg shadow-purple-600/30"
                      >
                        Create Staff Member
                      </button>
                    </form>
                  </div>

                  {/* System Accounts / User Management */}
                  <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                      <Users className="w-5 h-5 text-blue-400" />
                      Provisioned Accounts & Roles
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                            <th className="py-2.5 px-3">Name / Email</th>
                            <th className="py-2.5 px-3">Role</th>
                            <th className="py-2.5 px-3">2FA Active</th>
                            <th className="py-2.5 px-3">Created</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {adminUsers.map((u) => (
                            <tr key={u.id} className="hover:bg-slate-800/40">
                              <td className="py-2.5 px-3">
                                <span className="font-semibold text-slate-200 block">{u.full_name || 'Anonymous'}</span>
                                <span className="text-slate-400">{u.email}</span>
                              </td>
                              <td className="py-2.5 px-3">
                                <span className={`px-2 py-0.5 rounded-full font-bold uppercase ${
                                  u.role === 'ADMIN' ? 'bg-purple-950 text-purple-300 border border-purple-800' :
                                  u.role === 'STAFF' ? 'bg-amber-950 text-amber-300 border border-amber-800' :
                                  'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                }`}>
                                  {u.role}
                                </span>
                              </td>
                              <td className="py-2.5 px-3">
                                {u.two_factor_enabled ? (
                                  <span className="text-emerald-400 font-medium">✓ Enabled</span>
                                ) : (
                                  <span className="text-slate-500">Pending Setup</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-slate-400">
                                {new Date(u.created_at).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* PORTAL 2: INTERNAL STAFF WORKBENCH */}
            {currentUser.role === 'STAFF' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-extrabold text-white flex items-center gap-3">
                      <span className="p-2 bg-amber-600/20 text-amber-400 rounded-xl border border-amber-500/30">
                        <Layers className="w-7 h-7" />
                      </span>
                      Internal Staff Operations Workbench
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">
                      Customer subscriptions pipeline, quotations & payment logging (Restricted from pricing rules)
                    </p>
                  </div>
                  <button
                    onClick={fetchStaffData}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh Pipeline
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Subscription Pipeline */}
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                      <FileText className="w-5 h-5 text-amber-400" />
                      Active Customer Subscriptions
                    </h3>
                    <div className="space-y-3">
                      {staffPipeline?.subscriptions?.map((sub) => (
                        <div key={sub.id} className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                          <div>
                            <span className="text-xs font-mono text-amber-400 font-bold block">{sub.subscription_number}</span>
                            <span className="font-semibold text-slate-200 text-sm block">{sub.plan_name}</span>
                            <span className="text-xs text-slate-400">Customer: {sub.customer_name} ({sub.customer_email})</span>
                          </div>
                          <div className="text-right">
                            <span className="text-sm font-bold text-white block">${sub.amount.toFixed(2)} / {sub.billing_interval}</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">
                              {sub.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Invoice & Payment Processing */}
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                      <CreditCard className="w-5 h-5 text-emerald-400" />
                      Invoices & Payment Settlement
                    </h3>
                    <div className="space-y-3">
                      {staffPipeline?.invoices?.map((inv) => (
                        <div key={inv.id} className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                          <div>
                            <span className="text-xs font-mono text-blue-400 font-bold block">{inv.invoice_number}</span>
                            <span className="text-xs text-slate-400 block">Customer: {inv.customer_email}</span>
                            <span className="text-xs text-slate-500">Due: {inv.due_date}</span>
                          </div>
                          <div className="text-right flex items-center gap-3">
                            <div>
                              <span className="text-sm font-bold text-white block">${inv.total.toFixed(2)}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                                inv.status === 'Paid' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' :
                                'bg-amber-950 text-amber-400 border border-amber-800'
                              }`}>
                                {inv.status}
                              </span>
                            </div>
                            {inv.status !== 'Paid' && (
                              <button
                                onClick={() => handleRecordPayment(inv.id, inv.total)}
                                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-md transition"
                              >
                                Log Payment
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* PORTAL 3: CUSTOMER SELF-SERVICE PORTAL */}
            {currentUser.role === 'CUSTOMER' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-extrabold text-white flex items-center gap-3">
                      <span className="p-2 bg-emerald-600/20 text-emerald-400 rounded-xl border border-emerald-500/30">
                        <Building className="w-7 h-7" />
                      </span>
                      Customer Self-Service Portal
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">
                      Strictly segregated session data: Manage only your active subscriptions, invoices and payments
                    </p>
                  </div>
                  <button
                    onClick={fetchCustomerData}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh Portal
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* My Subscriptions */}
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                      <FileText className="w-5 h-5 text-emerald-400" />
                      My Active Subscriptions
                    </h3>
                    <div className="space-y-3">
                      {customerData?.subscriptions?.length === 0 && (
                        <p className="text-sm text-slate-500">No active subscriptions found.</p>
                      )}
                      {customerData?.subscriptions?.map((sub) => (
                        <div key={sub.id} className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                          <div>
                            <span className="text-xs font-mono text-emerald-400 font-bold block">{sub.subscription_number}</span>
                            <span className="font-semibold text-slate-200 text-base">{sub.plan_name}</span>
                            <span className="text-xs text-slate-400 block mt-1">Billing Interval: {sub.billing_interval}</span>
                            <span className="text-xs text-slate-500">Valid: {sub.start_date} to {sub.expiry_date}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-lg font-bold text-white block">${sub.amount.toFixed(2)}</span>
                            <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">
                              {sub.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* My Invoices & Payment History */}
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                      <CreditCard className="w-5 h-5 text-blue-400" />
                      Invoices & Statement
                    </h3>
                    <div className="space-y-3">
                      {customerData?.invoices?.length === 0 && (
                        <p className="text-sm text-slate-500">No invoices generated yet.</p>
                      )}
                      {customerData?.invoices?.map((inv) => (
                        <div key={inv.id} className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl flex items-center justify-between">
                          <div>
                            <span className="text-xs font-mono text-blue-400 font-bold block">{inv.invoice_number}</span>
                            <span className="text-xs text-slate-400 block">Due Date: {inv.due_date}</span>
                            <span className="text-xs text-slate-500">Tax: ${inv.tax.toFixed(2)}</span>
                          </div>
                          <div className="text-right flex items-center gap-3">
                            <div>
                              <span className="text-base font-bold text-white block">${inv.total.toFixed(2)}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                                inv.status === 'Paid' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' :
                                'bg-amber-950 text-amber-400 border border-amber-800'
                              }`}>
                                {inv.status}
                              </span>
                            </div>
                            <button
                              onClick={() => showNotice('info', `Simulating PDF download for ${inv.invoice_number}...`)}
                              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                            >
                              Download
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="border-t border-slate-800/80 p-4 text-center text-xs text-slate-500">
        Brightloop IAM &copy; 2026. Zero Trust Architecture with IDOR/BOLA Protection & 2FA.
      </footer>
    </div>
  );
}
