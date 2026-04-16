"use client";

import { useState, useMemo } from "react";

type Category = "All" | "Hardware" | "Software" | "Research" | "Orders" | "Testing" | "Links";

interface DocItem {
  title: string;
  description: string;
  category: Exclude<Category, "All">;
  href: string;
  external?: boolean;
}

const DOCS: DocItem[] = [
  // Hardware
  {
    title: "Firmware Design Doc",
    description: "Complete hardware spec: ESP32-S3, INMP441, 400mAh LiPo, USB-C",
    category: "Hardware",
    href: "/firmware/DESIGN.md",
  },
  {
    title: "PCB Schematic",
    description: "Pin mapping for all component connections",
    category: "Hardware",
    href: "/firmware/pcb/SCHEMATIC.md",
  },
  {
    title: "PCB Assembly Guide",
    description: "Step-by-step manufacturing instructions",
    category: "Hardware",
    href: "/firmware/pcb/ASSEMBLY.md",
  },
  {
    title: "KiCad Project Files",
    description: "KiCad schematic and project files",
    category: "Hardware",
    href: "/firmware/pcb/",
  },
  {
    title: "3D Case Design",
    description: "OpenSCAD parametric case, 38×25×11mm",
    category: "Hardware",
    href: "/firmware/case/anticipy_pendant.scad",
  },
  {
    title: "3D Product Render",
    description: "Interactive 3D render for presentations",
    category: "Hardware",
    href: "/firmware/case/render_product.html",
  },
  {
    title: "Packaging Design",
    description: "Box specs, branding, accessories",
    category: "Hardware",
    href: "/firmware/PACKAGING.md",
  },
  {
    title: "Manufacturing Order Guide",
    description: "How to order from JLCPCB, Bittele, etc.",
    category: "Hardware",
    href: "/firmware/MANUFACTURING_ORDER.md",
  },
  {
    title: "Component Order Sheet",
    description: "Direct buy links for all components, ~$90 CAD total",
    category: "Hardware",
    href: "/order.html",
  },

  // Software
  {
    title: "Engine Architecture",
    description: "Full system overview: Next.js, Supabase, Chrome extension",
    category: "Software",
    href: "/CLAUDE.md",
  },
  {
    title: "Intent Detection Prompt",
    description: "Chain-of-thought reasoning, context-aware importance",
    category: "Software",
    href: "/src/lib/intent-prompt.ts",
  },
  {
    title: "Execute Action",
    description: "3-tier execution: API, messaging, browser agent",
    category: "Software",
    href: "/src/lib/execute-action.ts",
  },
  {
    title: "Chrome Extension Agent",
    description: "LLM-powered browser automation in user's Chrome",
    category: "Software",
    href: "/extension/agent.js",
  },
  {
    title: "Extension Content Script",
    description: "DOM manipulation, form filling, page state extraction",
    category: "Software",
    href: "/extension/content.js",
  },
  {
    title: "Extension Install Page",
    description: "User-facing extension download and setup",
    category: "Software",
    href: "/engine/extension",
  },

  // Research
  {
    title: "Bill of Materials",
    description: "Verified component pricing: $28 CAD per prototype",
    category: "Research",
    href: "/docs/BOM.md",
  },
  {
    title: "Competitive Analysis",
    description: "8 competitors analyzed, market sizing $310B by 2033",
    category: "Research",
    href: "/docs/COMPETITIVE_ANALYSIS.md",
  },
  {
    title: "Component Order Page",
    description: "All components with direct purchase links",
    category: "Research",
    href: "/order.html",
  },

  // Testing
  {
    title: "Browser Test Suite",
    description: "10 real-world browser automation tests",
    category: "Testing",
    href: "/engine/test_real.py",
  },
  {
    title: "Stress Test Results",
    description: "5/5 complex tasks passing: Wikipedia, flights, forms, checkout, tables",
    category: "Testing",
    href: "#stress-tests",
  },
  {
    title: "Proactive Engine Tests",
    description: "9/9 intents correctly detected from realistic transcripts",
    category: "Testing",
    href: "#proactive-tests",
  },

  // Links
  {
    title: "GitHub — Anticipy",
    description: "Source code repository",
    category: "Links",
    href: "https://github.com/omize10/Anticipy",
    external: true,
  },
  {
    title: "Live Site",
    description: "Production website at anticipy.ai",
    category: "Links",
    href: "https://www.anticipy.ai",
    external: true,
  },
  {
    title: "Action Engine",
    description: "Live engine interface",
    category: "Links",
    href: "https://www.anticipy.ai/engine",
    external: true,
  },
  {
    title: "Supabase Dashboard",
    description: "Database, auth, and storage for project ogbxpqkmsdrcuilafycn",
    category: "Links",
    href: "https://supabase.com/dashboard/project/ogbxpqkmsdrcuilafycn",
    external: true,
  },
  {
    title: "Vercel Dashboard",
    description: "Deployments and environment variables",
    category: "Links",
    href: "https://vercel.com/omar-ebrahims-projects-022b18ec/anticipy",
    external: true,
  },
];

const CATEGORY_ICONS: Record<Category, string> = {
  All: "◈",
  Hardware: "⬡",
  Software: "⌘",
  Research: "◎",
  Orders: "◻",
  Testing: "◆",
  Links: "↗",
};

const CATEGORY_COLORS: Record<Exclude<Category, "All">, string> = {
  Hardware: "bg-amber-900/40 text-amber-300 border border-amber-800/50",
  Software: "bg-blue-900/40 text-blue-300 border border-blue-800/50",
  Research: "bg-purple-900/40 text-purple-300 border border-purple-800/50",
  Orders: "bg-green-900/40 text-green-300 border border-green-800/50",
  Testing: "bg-rose-900/40 text-rose-300 border border-rose-800/50",
  Links: "bg-zinc-800/60 text-zinc-300 border border-zinc-700/50",
};

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  // Substring match (handles typos via partial word matching)
  if (t.includes(q)) return true;
  // Character-sequence fuzzy match
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

const CATEGORIES: Category[] = ["All", "Hardware", "Software", "Research", "Orders", "Testing", "Links"];

export default function InternalPage() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<Category>("All");

  const filtered = useMemo(() => {
    return DOCS.filter((doc) => {
      const categoryMatch = activeCategory === "All" || doc.category === activeCategory;
      if (!categoryMatch) return false;
      if (!query.trim()) return true;
      return (
        fuzzyMatch(doc.title, query) ||
        fuzzyMatch(doc.description, query) ||
        fuzzyMatch(doc.category, query)
      );
    });
  }, [query, activeCategory]);

  const countByCategory = useMemo(() => {
    const counts: Partial<Record<Category, number>> = { All: DOCS.length };
    for (const doc of DOCS) {
      counts[doc.category] = (counts[doc.category] ?? 0) + 1;
    }
    return counts;
  }, []);

  return (
    <div
      className="min-h-screen"
      style={{ background: "#0C0C0C", color: "#F5F0EB", fontFamily: "var(--font-sans, sans-serif)" }}
    >
      {/* Header */}
      <div
        className="sticky top-0 z-10 border-b"
        style={{ background: "#0C0C0C", borderColor: "#252525" }}
      >
        <div className="max-w-5xl mx-auto px-4 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="flex items-center gap-2">
              <span style={{ color: "#C8A97E", fontSize: "1.1rem" }}>◈</span>
              <h1
                className="text-lg font-semibold tracking-tight"
                style={{ color: "#F5F0EB" }}
              >
                Anticipy Internal
              </h1>
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ background: "rgba(200,169,126,0.15)", color: "#C8A97E", border: "1px solid rgba(200,169,126,0.3)" }}
              >
                Team Only
              </span>
            </div>
            <div className="sm:ml-auto text-xs" style={{ color: "#8A8A8A" }}>
              {filtered.length} of {DOCS.length} documents
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 text-sm pointer-events-none"
              style={{ color: "#8A8A8A" }}
            >
              ⌕
            </span>
            <input
              type="text"
              placeholder="Search documents, specs, guides…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 rounded-lg text-sm outline-none transition-all"
              style={{
                background: "#161616",
                border: "1px solid #252525",
                color: "#F5F0EB",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "#C8A97E";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "#252525";
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs"
                style={{ color: "#8A8A8A" }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Category tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
            {CATEGORIES.map((cat) => {
              const isActive = activeCategory === cat;
              const count = countByCategory[cat] ?? 0;
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: isActive ? "rgba(200,169,126,0.15)" : "#161616",
                    color: isActive ? "#C8A97E" : "#8A8A8A",
                    border: isActive ? "1px solid rgba(200,169,126,0.4)" : "1px solid #252525",
                  }}
                >
                  <span>{CATEGORY_ICONS[cat]}</span>
                  <span>{cat}</span>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-xs"
                    style={{
                      background: isActive ? "rgba(200,169,126,0.2)" : "#252525",
                      color: isActive ? "#C8A97E" : "#5A5A5A",
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 py-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <span className="text-4xl" style={{ color: "#252525" }}>◎</span>
            <p className="text-sm" style={{ color: "#8A8A8A" }}>
              No documents match &ldquo;{query}&rdquo;
            </p>
            <button
              onClick={() => { setQuery(""); setActiveCategory("All"); }}
              className="text-xs underline"
              style={{ color: "#C8A97E" }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((doc) => (
              <DocCard key={`${doc.category}-${doc.title}`} doc={doc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DocCard({ doc }: { doc: DocItem }) {
  const isExternal = doc.external || doc.href.startsWith("http");
  const isPlaceholder = doc.href.startsWith("#");

  return (
    <a
      href={isPlaceholder ? undefined : doc.href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      onClick={isPlaceholder ? (e) => e.preventDefault() : undefined}
      className="group flex flex-col gap-2.5 p-4 rounded-xl transition-all"
      style={{
        background: "#161616",
        border: "1px solid #252525",
        cursor: isPlaceholder ? "default" : "pointer",
        textDecoration: "none",
      }}
      onMouseEnter={(e) => {
        if (!isPlaceholder) {
          e.currentTarget.style.borderColor = "rgba(200,169,126,0.35)";
          e.currentTarget.style.background = "#1A1A1A";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#252525";
        e.currentTarget.style.background = "#161616";
      }}
    >
      {/* Top row: category badge + external indicator */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[doc.category]}`}
        >
          {CATEGORY_ICONS[doc.category]} {doc.category}
        </span>
        {isExternal && (
          <span className="text-xs" style={{ color: "#5A5A5A" }}>↗</span>
        )}
        {isPlaceholder && (
          <span className="text-xs" style={{ color: "#5A5A5A" }}>internal</span>
        )}
      </div>

      {/* Title */}
      <p
        className="text-sm font-medium leading-snug"
        style={{ color: "#F5F0EB" }}
      >
        {doc.title}
      </p>

      {/* Description */}
      <p
        className="text-xs leading-relaxed flex-1"
        style={{ color: "#8A8A8A" }}
      >
        {doc.description}
      </p>

      {/* Path hint */}
      {!isExternal && !isPlaceholder && (
        <p
          className="text-xs font-mono truncate mt-auto"
          style={{ color: "#5A5A5A" }}
        >
          {doc.href}
        </p>
      )}
      {isExternal && (
        <p
          className="text-xs font-mono truncate mt-auto"
          style={{ color: "#5A5A5A" }}
        >
          {doc.href.replace("https://", "")}
        </p>
      )}
    </a>
  );
}
