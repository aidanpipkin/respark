import { NavLink } from 'react-router-dom';

const TABS = [
  ['/admin/command', 'Command center'],
  ['/admin', 'Agents'],
  ['/admin/onboard', 'Onboard an agent'],
  ['/admin/provisioning', 'Provisioning queue'],
  ['/admin/log', 'Provisioning log'],
  ['/admin/platform', 'Platform settings'],
];

/** Admin area navigation. */
export default function AdminTabs() {
  return (
    <nav aria-label="Admin" className="no-scrollbar -mx-4 mb-6 flex overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
      {TABS.map(([to, label]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => `-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors ${isActive ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
