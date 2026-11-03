import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const KEYS = [
  ['J / ↓', 'Next conversation'], ['K / ↑', 'Previous conversation'], ['Enter', 'Open the highlighted one'],
  ['R', 'Reply'], ['A', 'Approve the suggested reply'], ['⌘/Ctrl + Enter', 'Send your reply'],
  ['E', 'Done: mark read and go to the next'], ['U', 'Mark unread'], ['X', 'Select (Shift+X for a range)'],
  ['/', 'Search'], ['1–7', 'Switch tabs'], ['Esc', 'Clear selection or close'],
];

export default function ShortcutsHelp({ open, onOpenChange }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>Inbox shortcuts</DialogTitle><DialogDescription>Clear hundreds of conversations without touching the mouse.</DialogDescription></DialogHeader>
      <ul className="divide-y text-sm">{KEYS.map(([k, d]) => <li key={k} className="flex items-center justify-between gap-4 py-2"><span className="text-muted-foreground">{d}</span><kbd className="rounded-md border bg-muted px-2 py-0.5 font-mono text-[11px]">{k}</kbd></li>)}</ul>
      <p className="text-xs text-muted-foreground">Tip: Ctrl/⌘-click or click an avatar to start selecting, then Shift-click to select a range.</p>
    </DialogContent>
  </Dialog>;
}
