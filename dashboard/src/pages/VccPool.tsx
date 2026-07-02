import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  CreditCard,
  Trash2,
  Upload,
  CheckCircle,
  Wand2,
  Copy,
  Download,
  TrendingUp,
} from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { VisualCard } from "@/components/vcc/VisualCard";
import { ExportDialog } from "@/components/vcc/ExportDialog";
import { BinSelector } from "@/components/vcc/BinSelector";
import {
  generateVCCs,
  detectBrand,
  formatCardNumber,
  formatExpiry,
  parseCardLines,
  type GeneratedCard,
} from "@/lib/vcc-utils";
import type { BinEntry } from "@/lib/bin-data";

interface VCCCardInfo {
  id: number;
  last4: string;
  exp: string;
  name: string;
  status: string;
}

interface VCCPoolStatus {
  count: number;
  cards: VCCCardInfo[];
}

interface VCCTransaction {
  id: number;
  accountId: number;
  cardLast4: string;
  cardBrand: string;
  status: string;
  createdAt: string;
  email: string | null;
}

export default function VccPool() {
  const [pool, setPool] = useState<VCCPoolStatus>({ count: 0, cards: [] });
  const [transactions, setTransactions] = useState<VCCTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  // Generator state
  const [selectedBin, setSelectedBin] = useState("");
  const [binInfo, setBinInfo] = useState<BinEntry | null>(null);
  const [genCount, setGenCount] = useState(10);
  const [generatedCards, setGeneratedCards] = useState<GeneratedCard[]>([]);
  const [generating, setGenerating] = useState(false);

  // Import state
  const [bulkText, setBulkText] = useState("");

  // Export state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCards, setExportCards] = useState<GeneratedCard[]>([]);

  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const loadPool = useCallback(async () => {
    try {
      const data = await fetchApi<VCCPoolStatus>("/api/vcc/pool");
      setPool(data);
    } catch {
      setPool({ count: 0, cards: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const data = await fetchApi<{ transactions: VCCTransaction[] }>(
        "/api/vcc/transactions"
      );
      setTransactions(data.transactions || []);
    } catch {
      setTransactions([]);
    }
  }, []);

  useEffect(() => {
    loadPool();
    loadTransactions();
  }, [loadPool, loadTransactions]);

  // Stats
  const stats = useMemo(() => {
    const brandCounts: Record<string, number> = {};
    pool.cards.forEach((card) => {
      const brand = detectBrand(card.last4);
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    });
    return {
      total: pool.count,
      visa: brandCounts.visa || 0,
      mastercard: brandCounts.mastercard || 0,
      amex: brandCounts.amex || 0,
      other: (brandCounts.discover || 0) + (brandCounts.unknown || 0),
    };
  }, [pool]);

  // Generator
  const handleBinChange = (bin: string) => {
    setSelectedBin(bin);
  };

  const handleBinInfo = (info: BinEntry | null) => {
    setBinInfo(info);
  };

  const handleGenerate = async () => {
    if (!selectedBin || selectedBin.length < 6) {
      setMessage("Please select or enter a BIN (minimum 6 digits)");
      return;
    }

    setGenerating(true);
    try {
      // Generate cards with BIN info for better metadata
      const cards = generateVCCs(selectedBin, genCount);

      // Attach BIN info to each card
      const cardsWithInfo = cards.map(card => ({
        ...card,
        binInfo: binInfo || undefined
      }));

      setGeneratedCards(cardsWithInfo);
      setMessage(`Generated ${cardsWithInfo.length} cards`);
    } catch (error) {
      setMessage("Failed to generate cards");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyCard = async (card: GeneratedCard) => {
    const text = `${card.number}|${formatExpiry(card.expMonth, card.expYear)}|${card.cvv}`;
    await navigator.clipboard.writeText(text);
    setMessage("Card copied");
  };

  const handleCopyAll = async () => {
    const text = generatedCards
      .map((c) => `${c.number}|${formatExpiry(c.expMonth, c.expYear)}|${c.cvv}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
    setMessage(`${generatedCards.length} cards copied`);
  };

  const handleExportGenerated = () => {
    setExportCards(generatedCards);
    setExportOpen(true);
  };

  // Import
  const handleBulkImport = async () => {
    if (!bulkText.trim()) {
      setMessage("Paste card list first");
      return;
    }

    const cards = parseCardLines(bulkText);

    if (cards.length === 0) {
      setMessage("No valid cards found");
      return;
    }

    try {
      const formattedCards = cards.map((card) => ({
        number: card.number,
        expMonth: card.month,
        expYear: card.year.length === 2 ? `20${card.year}` : card.year,
        cvv: card.cvv,
        name: "John Doe",
      }));

      const result = await fetchApi<{ added: number }>("/api/vcc/pool", {
        method: "POST",
        body: JSON.stringify({ cards: formattedCards }),
      });
      setBulkText("");
      setMessage(`${result.added} cards imported`);
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Import failed");
    }
  };

  // Pool management
  const handleDelete = async (id: number) => {
    try {
      await fetchApi(`/api/vcc/pool/${id}`, { method: "DELETE" });
      setMessage("Card removed");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to remove card");
    }
  };

  const handleClearAll = async () => {
    if (!confirm("Remove all active VCC cards from pool?")) return;
    try {
      await fetchApi("/api/vcc/pool", { method: "DELETE" });
      setMessage("Pool cleared");
      loadPool();
    } catch (e: any) {
      setMessage(e.message || "Failed to clear pool");
    }
  };

  const handleExportPool = () => {
    const cards: GeneratedCard[] = pool.cards.map((c) => ({
      bin: "",
      number: `****${c.last4}`,
      expMonth: c.exp.split("/")[0] || "",
      expYear: `20${c.exp.split("/")[1] || ""}`,
      cvv: "***",
      brand: detectBrand(c.last4),
    }));
    setExportCards(cards);
    setExportOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">VCC Pool</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Generate and manage virtual credit cards with real-time BIN lookup
          </p>
        </div>
        <Badge variant="secondary" className="text-base px-4 py-2">
          {pool.count} active card{pool.count !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Stats */}
      {pool.count > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card>
            <CardContent className="pt-6 pb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-[var(--primary)]" />
                <div className="text-2xl font-bold">{stats.total}</div>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">Total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 pb-4">
              <div className="text-2xl font-bold text-blue-500">{stats.visa}</div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Visa
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 pb-4">
              <div className="text-2xl font-bold text-orange-500">
                {stats.mastercard}
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Mastercard
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 pb-4">
              <div className="text-2xl font-bold text-cyan-500">{stats.amex}</div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">Amex</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 pb-4">
              <div className="text-2xl font-bold">{stats.other}</div>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">Other</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Message */}
      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {message}
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="generator" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="generator">Generator</TabsTrigger>
          <TabsTrigger value="generated">
            Generated {generatedCards.length > 0 && `(${generatedCards.length})`}
          </TabsTrigger>
          <TabsTrigger value="pool">Pool ({pool.count})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Generator Tab */}
        <TabsContent value="generator">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Controls */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wand2 className="w-4 h-4" />
                  Generate VCC
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <BinSelector
                  value={selectedBin}
                  onChange={handleBinChange}
                  onBinInfo={handleBinInfo}
                />

                <div>
                  <label className="text-sm font-medium mb-2 block">
                    Number of Cards
                  </label>
                  <Input
                    type="number"
                    value={genCount}
                    onChange={(e) => setGenCount(parseInt(e.target.value) || 1)}
                    min={1}
                    max={100}
                  />
                </div>

                <Button
                  onClick={handleGenerate}
                  className="w-full"
                  disabled={generating}
                >
                  <Wand2 className="w-4 h-4 mr-2" />
                  {generating ? "Generating..." : `Generate ${genCount} Cards`}
                </Button>
              </CardContent>
            </Card>

            {/* Right: Preview */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <VisualCard
                  number={selectedBin.padEnd(16, "0")}
                  expMonth="12"
                  expYear="2030"
                  name={binInfo?.issuer || "CARDHOLDER NAME"}
                  brand={detectBrand(selectedBin)}
                />
                {binInfo && (
                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Brand:</span>
                      <span className="font-medium capitalize">{binInfo.brand}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Country:</span>
                      <span className="font-medium">{binInfo.countryName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Bank:</span>
                      <span className="font-medium">{binInfo.issuer || "Unknown"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--muted-foreground)]">Type:</span>
                      <span className="font-medium capitalize">{binInfo.type}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Generated Cards Tab */}
        <TabsContent value="generated">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Generated Cards</CardTitle>
                {generatedCards.length > 0 && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleCopyAll}>
                      <Copy className="w-3 h-3 mr-1" />
                      Copy All
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleExportGenerated}>
                      <Download className="w-3 h-3 mr-1" />
                      Export
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {generatedCards.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
                  No cards generated yet. Go to Generator tab to create cards.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {generatedCards.map((card, idx) => (
                    <div key={idx} className="space-y-2">
                      <VisualCard
                        number={card.number}
                        exp={formatExpiry(card.expMonth, card.expYear)}
                        name={card.binInfo?.issuer || "CARDHOLDER NAME"}
                        brand={card.brand || detectBrand(card.number)}
                        showActions
                        onCopy={() => handleCopyCard(card)}
                      />
                      <div className="text-xs font-mono text-[var(--muted-foreground)] px-1">
                        <div>{formatCardNumber(card.number)}</div>
                        <div className="flex justify-between mt-1">
                          <span>Exp: {formatExpiry(card.expMonth, card.expYear)}</span>
                          <span>CVV: {card.cvv}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pool Tab */}
        <TabsContent value="pool">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  Active Cards in Pool
                </CardTitle>
                <div className="flex flex-wrap gap-2">
                  {pool.count > 0 && (
                    <>
                      <Button variant="outline" size="sm" onClick={handleExportPool}>
                        <Download className="w-3 h-3 mr-1" />
                        Export
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleClearAll}
                        className="text-[var(--error)]"
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Clear All
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Bulk Import */}
              <div className="mb-6 pb-6 border-b border-[var(--border)]">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Import Cards
                </h3>
                <div className="space-y-3">
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder="Paste cards (one per line):

number|mm/yy|cvv
4111111111111111|12/30|123

or: number|mm|yy|cvv
4111111111111111|12|30|123"
                    className="w-full h-[120px] px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                  />
                  <Button onClick={handleBulkImport} className="w-full">
                    <Upload className="w-4 h-4 mr-2" />
                    Import Cards
                  </Button>
                </div>
              </div>

              {/* Active Cards List */}
              {loading ? (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
                  Loading...
                </p>
              ) : pool.cards.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
                  No active cards in pool. Generate or import cards above.
                </p>
              ) : (
                <div className="space-y-2">
                  {pool.cards.map((card) => (
                    <div
                      key={card.id}
                      className="flex items-center justify-between px-4 py-3 rounded-md bg-[var(--secondary)] hover:bg-[var(--muted)] transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <CreditCard className="w-4 h-4 text-[var(--muted-foreground)] flex-shrink-0" />
                        <span className="font-mono text-sm truncate">
                          •••• •••• •••• {card.last4}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {card.exp}
                        </Badge>
                        <span className="text-xs text-[var(--muted-foreground)] truncate hidden sm:inline">
                          {card.name}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(card.id)}
                        className="flex-shrink-0"
                      >
                        <Trash2 className="w-3 h-3 text-[var(--error)]" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                Upgrade History
              </CardTitle>
            </CardHeader>
            <CardContent>
              {transactions.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)] text-center py-8">
                  No upgrade transactions yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {transactions.map((tx) => (
                    <div
                      key={tx.id}
                      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-3 rounded-md bg-[var(--secondary)]"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <CheckCircle
                          className={`w-4 h-4 flex-shrink-0 ${
                            tx.status === "success"
                              ? "text-[var(--success)]"
                              : "text-[var(--error)]"
                          }`}
                        />
                        <span className="font-mono text-sm">
                          •••• {tx.cardLast4}
                        </span>
                        <span className="text-sm truncate">
                          {tx.email || `Account #${tx.accountId}`}
                        </span>
                        <Badge
                          variant={
                            tx.status === "success" ? "success" : "destructive"
                          }
                          className="text-xs"
                        >
                          {tx.status}
                        </Badge>
                      </div>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {new Date(tx.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Export Dialog */}
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        cards={exportCards}
        onMessage={setMessage}
      />
    </div>
  );
}
