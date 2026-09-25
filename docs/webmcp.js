(function () {
  "use strict";

  var state = { enabled: false, tools: [], preview: true };
  if (typeof window !== "undefined") window.__opencodeComputerUseWebMCP = state;
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;

  var modelContext = null;
  try {
    modelContext = document.modelContext;
  } catch (_) {
    return;
  }
  if (!modelContext || typeof modelContext.registerTool !== "function") return;

  function plainText(element, limit) {
    var text = String(element && element.textContent || "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim();
    return text.slice(0, limit);
  }

  function result(value) {
    return String(value).slice(0, 8000);
  }

  function queryValue(value, fallback) {
    return typeof value === "string" ? value.trim() : fallback;
  }

  function searchDocs(args) {
    var query = queryValue(args && args.query, "");
    if (!query || query.length > 200) return "Invalid query. Provide 1 to 200 characters.";
    var needle = query.toLowerCase();
    var sections = document.querySelectorAll("#content [data-section]");
    var matches = [];
    for (var index = 0; index < sections.length; index += 1) {
      var section = sections[index];
      var heading = section.querySelector("h2, h3");
      var text = plainText(section, 12000);
      var position = text.toLowerCase().indexOf(needle);
      if (position === -1) continue;
      var start = Math.max(0, position - 200);
      var end = Math.min(text.length, position + query.length + 600);
      matches.push((heading ? heading.textContent.trim() + "\n" : "") + text.slice(start, end));
      if (matches.join("\n\n").length >= 8000) break;
    }
    return result(matches.length ? matches.join("\n\n") : "No documentation matches found for: " + query);
  }

  function getInstallConfig(args) {
    var generation = args && args.generation;
    if (generation !== "v1" && generation !== "v2") return "Invalid generation. Use v1 or v2.";
    var block = document.getElementById(generation === "v1" ? "config-v1" : "config-v2");
    return block ? result(plainText(block, 4000)) : "Install configuration is unavailable on this page.";
  }

  function getApiReference(args) {
    var requested = queryValue(args && args.name, "").toLowerCase();
    if (!requested || requested.length > 100) return "Invalid name. Provide 1 to 100 characters.";
    var entries = document.querySelectorAll("#api .cards li");
    for (var index = 0; index < entries.length; index += 1) {
      var label = entries[index].querySelector("strong");
      if (!label) continue;
      var documented = String(label.textContent || "").trim().toLowerCase();
      var method = documented.split(".").pop();
      if (documented === requested || documented.endsWith("." + requested) || (requested.indexOf(".") === -1 && method === requested)) {
        return result(plainText(entries[index], 2000));
      }
    }
    return "No API entry found for: " + requested;
  }

  var tools = [
    {
      name: "search_docs",
      title: "Search documentation",
      description: "Search this documentation page and return bounded matching excerpts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200, description: "Text to find in the documentation." }
        },
        required: ["query"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false, debugging: false },
      execute: searchDocs
    },
    {
      name: "get_install_config",
      title: "Get installation configuration",
      description: "Return the documented OpenCode installation configuration for one generation.",
      inputSchema: {
        type: "object",
        properties: {
          generation: { type: "string", enum: ["v1", "v2"], description: "OpenCode configuration generation." }
        },
        required: ["generation"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false, debugging: false },
      execute: getInstallConfig
    },
    {
      name: "get_api_reference",
      title: "Get API reference",
      description: "Return one documented CUA API entry by method name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100, description: "Method name, with or without its cua or app prefix." }
        },
        required: ["name"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false, debugging: false },
      execute: getApiReference
    }
  ];

  Promise.all(tools.map(function (tool) {
    return Promise.resolve().then(function () {
      return modelContext.registerTool(tool);
    }).then(function () {
      state.tools.push(tool.name);
    }).catch(function () {
      // Experimental registration failures must not affect normal documentation.
    });
  })).then(function () {
    state.enabled = state.tools.length > 0;
  });
}());
