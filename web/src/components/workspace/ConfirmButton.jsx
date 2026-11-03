import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';

/** A button that asks once before doing something that cannot be undone. `onConfirm` runs after the person agrees. */
export default function ConfirmButton({ title, description, confirmLabel = 'Confirm', destructive = false, onConfirm, children, ...buttonProps }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" {...buttonProps} onClick={() => setOpen(true)}>{children}</Button>
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction className={destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''} onClick={() => { setOpen(false); onConfirm?.(); }}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
