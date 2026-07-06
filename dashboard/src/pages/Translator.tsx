import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Bug, Play, ChevronRight } from "lucide-react";

const PIPELINE_STAGES = [
  { id: "raw", label: "1. Raw Input", desc: "Client request as received" },
  { id: "normalized", label: "2. Normalized", desc: "Model alias resolved, fields canonicalized" },
  { id: "filtered", label: "3. Filtered", desc: "Pudidil filters applied (telemetry/brand neutralization)" },
  { id: "compressed", label: "4. Compressed", desc: "RTK/TSC/cache-markers applied" },
  { id: "mapped", label: "5. Mapped", desc: "Model mapped to provider target" },
  { id: "transformed", label: "6. Transformed", desc: "Converted to provider-native format" },
  { id: "response", label: "7. Response", desc: "Provider response, back-transformed" },
];

export default function Translator() {
  const [input, setInput] = useState(`{
  "model": "claude-sonnet-4",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true
}`);
  const [activeStage, setActiveStage] = useState("raw");
  const [stages, setStages] = useState<Record<string, string>>({ raw: input });
  const [running, setRunning] = useState(false);

  async function runDebugger() {
    setRunning(true);
    setStages({ raw: input });
    try {
      // Send the request through the translator endpoint (dry-run mode).
      const res = await fetch("/api/translator/debug", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: JSON.parse(input), dryRun: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setStages({
          raw: JSON.stringify(data.raw ?? JSON.parse(input), null, 2),
          normalized: JSON.stringify(data.normalized, null, 2),
          filtered: JSON.stringify(data.filtered, null, 2),
          compressed: JSON.stringify(data.compressed, null, 2),
          mapped: JSON.stringify(data.mapped, null, 2),
          transformed: JSON.stringify(data.transformed, null, 2),
          response: JSON.stringify(data.response, null, 2),
        });
      } else {
        setStages({ raw: `Error: ${await res.text()}` });
      }
    } catch (err: any) {
      setStages({ raw: `Error: ${err.message}` });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Bug className="w-6 h-6" /> Request Translator
        </h1>
        <p className="text-muted-foreground mt-1">
          Debug a request through the full 7-stage transform pipeline. See exactly what each stage produces before it hits the provider.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Input Request</CardTitle>
            <CardDescription>Paste a chat-completion or messages request</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="font-mono text-xs min-h-[300px]"
            />
            <Button onClick={runDebugger} disabled={running}>
              <Play className="w-4 h-4 mr-1" /> {running ? "Running…" : "Run Pipeline"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pipeline Stages</CardTitle>
            <CardDescription>Click a stage to inspect its output</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1 mb-3">
              {PIPELINE_STAGES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setActiveStage(s.id)}
                  className={`text-xs px-2 py-1 rounded border transition ${
                    activeStage === s.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-input hover:bg-muted"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground mb-2">
              {PIPELINE_STAGES.find((s) => s.id === activeStage)?.desc}
            </div>
            <pre className="font-mono text-xs bg-muted p-3 rounded min-h-[280px] max-h-[400px] overflow-auto whitespace-pre-wrap break-all">
              {stages[activeStage] || "// Run the pipeline to see this stage's output"}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
