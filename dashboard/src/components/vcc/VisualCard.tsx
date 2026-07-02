import { cn } from '@/lib/utils';
import { getBrandGradient, getBrandName, formatCardNumber, formatExpiry } from '@/lib/vcc-utils';
import { Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';

interface VisualCardProps {
  number?: string;
  last4?: string;
  exp?: string;
  expMonth?: string;
  expYear?: string;
  name?: string;
  brand?: string;
  className?: string;
  onCopy?: () => void;
  onDelete?: () => void;
  showActions?: boolean;
}

// Brand logo SVGs
function BrandLogo({ brand }: { brand: string }): ReactNode {
  const logos: Record<string, ReactNode> = {
    visa: (
      <svg viewBox="0 0 100 40" className="h-8 fill-white">
        <path d="M40 32h-7l4-24h7l-4 24zm28-23l-3 15-4-2c-1-.5-2-.8-3-.8-3 0-5 1-5 3 0 1 1 2 2 2h5c4 0 6 2 6 5 0 5-4 8-10 8-3 0-6-1-8-2l1-3c2 1 4 2 7 2 3 0 5-1 5-3s-2-2-5-2h-4c-2 0-3-1-3-3 0-4 4-8 10-8 2 0 4 0 5 1l-1-4zm-30 1c2 0 3 1 3 1l1-4s-2-1-5-1c-5 0-8 3-8 6 0 3 2 4 5 6 2 1 3 2 3 3 0 2-2 3-4 3-2 0-4-1-5-1l-1 4c2 1 4 2 7 2 5 0 8-3 8-7 0-2-1-4-4-5-2-1-3-2-3-3 0-2 2-3 4-3zm50-1l-6 15-1-7c0-2-1-3-2-4l-3 11h-7l6-24h6l0 12 5-12h2z" />
      </svg>
    ),
    mastercard: (
      <div className="flex items-center h-8">
        <div className="w-8 h-8 rounded-full bg-red-500" />
        <div className="w-8 h-8 rounded-full bg-orange-500 -ml-3 opacity-80" />
      </div>
    ),
    amex: (
      <div className="text-white font-bold text-lg tracking-wider">
        AMERICAN<br />EXPRESS
      </div>
    ),
    discover: (
      <div className="text-white font-bold text-xl">
        DISCOVER
      </div>
    ),
    jcb: (
      <div className="flex gap-1 h-8">
        <div className="w-6 bg-blue-500 rounded flex items-center justify-center text-white font-bold text-xs">J</div>
        <div className="w-6 bg-red-500 rounded flex items-center justify-center text-white font-bold text-xs">C</div>
        <div className="w-6 bg-green-500 rounded flex items-center justify-center text-white font-bold text-xs">B</div>
      </div>
    ),
    unionpay: (
      <div className="text-white font-bold text-lg">
        UnionPay
      </div>
    ),
    diners: (
      <div className="text-white font-bold text-lg">
        DINERS
      </div>
    ),
  };

  return logos[brand] || <div className="text-white font-bold text-lg">CARD</div>;
}

export function VisualCard({
  number,
  last4,
  exp,
  expMonth,
  expYear,
  name = 'CARDHOLDER NAME',
  brand = 'unknown',
  className,
  onCopy,
  onDelete,
  showActions = false,
}: VisualCardProps) {
  const gradient = getBrandGradient(brand);
  const displayNumber = number
    ? formatCardNumber(number)
    : last4
    ? `•••• •••• •••• ${last4}`
    : '•••• •••• •••• ••••';
  const displayExp = exp || formatExpiry(expMonth || '01', expYear || '2030');

  return (
    <div
      className={cn(
        'relative w-full aspect-[1.586/1] rounded-xl overflow-hidden shadow-lg group',
        className
      )}
    >
      {/* Gradient background */}
      <div className={cn('absolute inset-0 bg-gradient-to-br', gradient)} />

      {/* Decorative circles */}
      <div className="absolute -top-20 -right-20 w-60 h-60 rounded-full bg-white/5" />
      <div className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full bg-white/5" />

      {/* Content */}
      <div className="relative h-full flex flex-col justify-between p-6 text-white">
        {/* Top: Brand logo */}
        <div className="flex justify-end">
          <BrandLogo brand={brand} />
        </div>

        {/* Middle: Card number */}
        <div className="text-xl md:text-2xl font-mono tracking-wider select-all">
          {displayNumber}
        </div>

        {/* Bottom: Name and expiry */}
        <div className="flex justify-between items-end">
          <div>
            <div className="text-xs uppercase text-white/70 mb-1">Card Holder</div>
            <div className="text-sm md:text-base uppercase tracking-wider font-medium">
              {name}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-white/70 mb-1">Expires</div>
            <div className="text-sm md:text-base font-mono">{displayExp}</div>
          </div>
        </div>
      </div>

      {/* Action buttons overlay */}
      {showActions && (onCopy || onDelete) && (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onCopy && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onCopy}
              className="h-8 w-8 bg-black/30 hover:bg-black/50 text-white"
            >
              <Copy className="w-4 h-4" />
            </Button>
          )}
          {onDelete && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onDelete}
              className="h-8 w-8 bg-black/30 hover:bg-black/50 text-white"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
