import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CardData, exportAsTxt, exportAsCsv, exportAsJson } from '@/lib/vcc-utils';
import { Copy, Download } from 'lucide-react';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: CardData[];
  onMessage?: (message: string) => void;
}

export function ExportDialog({ open, onOpenChange, cards, onMessage }: ExportDialogProps) {
  const [format, setFormat] = useState<'txt' | 'csv' | 'json'>('txt');

  const getExportContent = () => {
    switch (format) {
      case 'txt':
        return exportAsTxt(cards);
      case 'csv':
        return exportAsCsv(cards);
      case 'json':
        return exportAsJson(cards);
    }
  };

  const exportContent = getExportContent();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportContent);
      onMessage?.(`Copied ${cards.length} cards to clipboard`);
    } catch (err) {
      onMessage?.('Failed to copy to clipboard');
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vcc-cards-${format}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onMessage?.(`Downloaded ${cards.length} cards as ${format.toUpperCase()}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export Cards</DialogTitle>
          <DialogDescription>
            Export {cards.length} cards in your preferred format
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Format selector */}
          <div className="flex gap-2">
            <Button
              variant={format === 'txt' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFormat('txt')}
            >
              TXT
            </Button>
            <Button
              variant={format === 'csv' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFormat('csv')}
            >
              CSV
            </Button>
            <Button
              variant={format === 'json' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFormat('json')}
            >
              JSON
            </Button>
          </div>

          {/* Preview */}
          <Textarea
            value={exportContent}
            readOnly
            className="h-[300px] font-mono text-xs resize-none"
          />

          {/* Actions */}
          <div className="flex gap-2">
            <Button onClick={handleCopy} className="flex-1">
              <Copy className="w-4 h-4 mr-2" />
              Copy to Clipboard
            </Button>
            <Button onClick={handleDownload} variant="outline" className="flex-1">
              <Download className="w-4 h-4 mr-2" />
              Download File
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
