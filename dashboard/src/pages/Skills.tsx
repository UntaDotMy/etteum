import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  source: "built-in" | "mcp" | "custom";
}

const DEFAULT_SKILLS: Skill[] = [
  { id: "web-search", name: "Web Search", description: "Search the web and return structured results", category: "retrieval", source: "built-in" },
  { id: "code-interpreter", name: "Code Interpreter", description: "Execute Python/JS in a sandbox", category: "compute", source: "built-in" },
  { id: "file-search", name: "File Search", description: "Semantic search over uploaded files (RAG)", category: "retrieval", source: "built-in" },
  { id: "image-gen", name: "Image Generation", description: "Generate images from text prompts", category: "media", source: "built-in" },
  { id: "tts", name: "Text-to-Speech", description: "Convert text to spoken audio", category: "media", source: "built-in" },
  { id: "stt", name: "Speech-to-Text", description: "Transcribe audio to text", category: "media", source: "built-in" },
  { id: "mcp-filesystem", name: "MCP: Filesystem", description: "Local filesystem access via MCP", category: "mcp", source: "mcp" },
  { id: "mcp-fetch", name: "MCP: Fetch", description: "HTTP fetch tool via MCP", category: "mcp", source: "mcp" },
  { id: "mcp-sqlite", name: "MCP: SQLite", description: "SQLite database explorer via MCP", category: "mcp", source: "mcp" },
];

const CATEGORIES = ["all", "retrieval", "compute", "media", "mcp"];

export default function Skills() {
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("all");

  const filtered = DEFAULT_SKILLS.filter((s) => {
    if (category !== "all" && s.category !== category) return false;
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase()) && !s.description.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="w-6 h-6" /> Skills
        </h1>
        <p className="text-muted-foreground mt-1">
          Catalog of capabilities the router can inject into requests — built-in tools, MCP plugins, and custom skills.
        </p>
      </div>

      <div className="flex gap-2 items-center">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="search skills…" className="pl-8" />
        </div>
        <div className="flex gap-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`text-xs px-3 py-1.5 rounded-full border transition capitalize ${
                category === cat ? "bg-primary text-primary-foreground border-primary" : "bg-background border-input hover:bg-muted"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((skill) => (
          <Card key={skill.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{skill.name}</CardTitle>
                <Badge variant={skill.source === "built-in" ? "default" : skill.source === "mcp" ? "secondary" : "outline"}>
                  {skill.source}
                </Badge>
              </div>
              <CardDescription className="text-xs">{skill.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="text-xs text-muted-foreground capitalize">{skill.category}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
