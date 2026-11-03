import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sparkles } from 'lucide-react';
import ChatDemo from '@/components/dashboard/ChatDemo';

/** Practice chat with the agent's own AI, using their real name and agency. Nothing is sent. */
export default function TryMyAI({ open, onClose, settings }) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="flex max-h-[92dvh] max-w-md flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base"><Sparkles size={17} className="text-primary" />Text your AI</DialogTitle>
          <DialogDescription className="text-xs">You're Marcus, a sample lead: owner-operator in Arkansas, married with two daughters, asked about coverage 8 months ago. Reply however he might. Nothing is sent to anyone.</DialogDescription>
        </DialogHeader>
        <ChatDemo endpoint="tryMyAI" agent={settings?.first_name || 'your agent'} agency={settings?.brand_name || 'our office'} className="flex-1" autoFocus />
      </DialogContent>
    </Dialog>
  );
}
