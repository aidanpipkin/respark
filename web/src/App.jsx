import { lazy, Suspense } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { FeedbackToaster, FeedbackRouterBridge } from '@/lib/feedback';
import ErrorBoundary from '@/components/system/ErrorBoundary';
import { AppLoader } from '@/components/system/Loaders';
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ProtectedRoute from '@/components/ProtectedRoute';
const Login = lazy(() => import('@/pages/Login'));
const Register = lazy(() => import('@/pages/Register'));
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));
import WorkspaceLayout from '@/components/workspace/WorkspaceLayout';
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Inbox = lazy(() => import('@/pages/Inbox'));
const Campaigns = lazy(() => import('@/pages/Campaigns'));
const Profile = lazy(() => import('@/pages/Profile'));
const Contacts = lazy(() => import('@/pages/Contacts'));
const ContactDetail = lazy(() => import('@/pages/ContactDetail'));
const Appointments = lazy(() => import('@/pages/Appointments'));
const Pipeline = lazy(() => import('@/pages/Pipeline'));
const Clients = lazy(() => import('@/pages/Clients'));
import AdminGuard from '@/components/admin/AdminGuard';
const AdminAgents = lazy(() => import('@/pages/AdminAgents'));
const AdminOnboard = lazy(() => import('@/pages/AdminOnboard'));
const ProvisioningLog = lazy(() => import('@/pages/ProvisioningLog'));
const AdminPlatform = lazy(() => import('@/pages/AdminPlatform'));
import PublicLayout from '@/components/public/PublicLayout';
const PublicHome = lazy(() => import('@/pages/PublicHome'));
const PublicTerms = lazy(() => import('@/pages/PublicTerms'));
const PublicPrivacy = lazy(() => import('@/pages/PublicPrivacy'));
const AgentSite = lazy(() => import('@/pages/AgentSite'));
const ImportLeads = lazy(() => import('@/pages/ImportLeads'));

const SetupBilling = lazy(() => import('@/pages/SetupBilling'));
const SetupNumber = lazy(() => import('@/pages/SetupNumber'));
const SetupTexting = lazy(() => import('@/pages/SetupTexting'));
const SetupCalendar = lazy(() => import('@/pages/SetupCalendar'));
const AdminProvisioning = lazy(() => import('@/pages/AdminProvisioning'));
const AdminCommand = lazy(() => import('@/pages/AdminCommand'));
const ConsentProof = lazy(() => import('@/pages/ConsentProof'));
const Numbers = lazy(() => import('@/pages/Numbers'));
const Welcome = lazy(() => import('@/pages/Welcome'));

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const publicPath=['/','/get-info','/privacy','/terms','/sms-terms','/login','/register','/forgot-password','/reset-password'].includes(window.location.pathname)||window.location.pathname.startsWith('/a/');

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return <AppLoader />;
  }

  // Handle authentication errors
  if (authError && !publicPath) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Suspense fallback={<AppLoader />}>
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<PublicHome />} />
        <Route path="/get-info" element={<Navigate to="/register" replace />} />
        <Route path="/privacy" element={<PublicPrivacy />} />
        <Route path="/terms" element={<PublicTerms />} />
        <Route path="/sms-terms" element={<Navigate to="/terms" replace />} />
      </Route>
      <Route path="/a/:slug/*" element={<AgentSite />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<WorkspaceLayout />}>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/contacts/import" element={<ImportLeads />} />
          <Route path="/contacts/:id" element={<ContactDetail />} />
          <Route path="/contacts/:id/consent" element={<ConsentProof />} />
          <Route path="/appointments" element={<Appointments />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/numbers" element={<Numbers />} />
          <Route path="/setup/billing" element={<SetupBilling />} />
          <Route path="/credits" element={<SetupBilling />} />
          <Route path="/setup/number" element={<SetupNumber />} />
          <Route path="/setup/texting-registration" element={<SetupTexting />} />
          <Route path="/setup/calendar" element={<SetupCalendar />} />
          <Route path="/settings" element={<Navigate to="/profile" replace />} />
          <Route element={<AdminGuard />}>
            <Route path="/admin" element={<AdminAgents />} />
            <Route path="/admin/onboard" element={<AdminOnboard />} />
            <Route path="/admin/log" element={<ProvisioningLog />} />
            <Route path="/admin/platform" element={<AdminPlatform />} />
            <Route path="/admin/provisioning" element={<AdminProvisioning />} />
            <Route path="/admin/command" element={<AdminCommand />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
    </Suspense>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <FeedbackRouterBridge />
          <ErrorBoundary>
            <AuthenticatedApp />
          </ErrorBoundary>
        </Router>
        <Toaster />
        <FeedbackToaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App