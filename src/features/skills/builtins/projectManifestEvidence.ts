type ManifestFacts = Record<string, string | number | boolean>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function stringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.entries(value).every(([key, item]) =>
    nonemptyString(key) && !/\s/.test(key) && nonemptyString(item));
}

/** JSON.parse validates syntax first; this pass rejects ambiguous duplicate keys. */
function duplicateJsonKeys(content: string): boolean {
  const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
  for (const match of content.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = match[0];
    const frame = stack[stack.length - 1];
    if (token === "{" || token === "[") {
      stack.push({ object: token === "{", key: true, keys: new Set() });
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (frame?.object) {
      if (token === ",") frame.key = true;
      else if (token === ":") frame.key = false;
      else if (token.startsWith('"') && frame.key) {
        const key: string = JSON.parse(token);
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
      }
    }
  }
  return false;
}

/** Field shapes: https://docs.npmjs.com/cli/v11/configuring-npm/package-json/ */
function inspectNpm(content: string): ManifestFacts | undefined {
  const manifest: unknown = JSON.parse(content);
  if (!isObject(manifest) || duplicateJsonKeys(content)) return undefined;
  const maps = ["scripts", "dependencies", "devDependencies", "engines"];
  for (const key of maps) {
    if (Object.prototype.hasOwnProperty.call(manifest, key) && !stringMap(manifest[key])) return undefined;
  }
  // packageManager identifies a tool and its requested version, not a Node version.
  // https://nodejs.org/download/release/v22.0.0/docs/api/packages.html#packagemanager
  const manager = manifest.packageManager;
  if (Object.prototype.hasOwnProperty.call(manifest, "packageManager")
    && (!nonemptyString(manager) || !/^[a-z][a-z0-9._-]*@[^@\s]+$/i.test(manager))) return undefined;
  const hasProjectField = maps.some((key) => isObject(manifest[key]) && Object.keys(manifest[key]).length > 0)
    || nonemptyString(manager);
  if (!hasProjectField) return undefined;
  const scripts = manifest.scripts as Record<string, string> | undefined;
  const engines = manifest.engines as Record<string, string> | undefined;
  return {
    manifestFormat: "npm",
    buildEntryKnown: nonemptyString(scripts?.build),
    runtimeRequirementKnown: nonemptyString(engines?.node),
  };
}

function children(element: Element, localName: string): Element[] {
  return Array.from(element.children).filter((child) =>
    child.localName === localName && child.namespaceURI === element.namespaceURI);
}

function singleChild(element: Element, localName: string): Element | undefined {
  const matches = children(element, localName);
  return matches.length === 1 ? matches[0] : undefined;
}

function leafText(element: Element | undefined): string | undefined {
  if (!element || element.children.length) return undefined;
  const text = element.textContent?.trim();
  return nonemptyString(text) ? text : undefined;
}

function declaredJavaVersion(element: Element | undefined): boolean {
  const value = leafText(element);
  // Preserve an explicit property reference as a declaration, without resolving
  // it or claiming that a particular JDK is available or compatible.
  return value !== undefined && /^(?:[1-9]\d*(?:\.\d+)*(?:[-+][a-z0-9.-]+)?|\$\{[^{}\s]+\})$/i.test(value);
}

function javaRequirementDeclared(project: Element): boolean {
  const properties = singleChild(project, "properties");
  if (properties && ["java.version", "maven.compiler.release", "maven.compiler.source", "maven.compiler.target"]
    .some((key) => declaredJavaVersion(singleChild(properties, key)))) return true;
  const build = singleChild(project, "build");
  const plugins = build && singleChild(build, "plugins");
  return !!plugins && children(plugins, "plugin").some((plugin) => {
    const group = leafText(singleChild(plugin, "groupId"));
    if ((children(plugin, "groupId").length > 0 && group !== "org.apache.maven.plugins")
      || leafText(singleChild(plugin, "artifactId")) !== "maven-compiler-plugin") return false;
    const configuration = singleChild(plugin, "configuration");
    return !!configuration && ["release", "source", "target"]
      .some((key) => declaredJavaVersion(singleChild(configuration, key)));
  });
}

function inspectMaven(content: string): ManifestFacts | undefined {
  // Reject DTDs before parsing, including external entities and entity expansion.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(content) || typeof DOMParser === "undefined") return undefined;
  const document = new DOMParser().parseFromString(content, "application/xml");
  const project = document.documentElement;
  if (document.doctype || document.children.length !== 1 || !project || project.localName !== "project"
    || Array.from(document.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim())
    || document.getElementsByTagNameNS("*", "parsererror").length
    || document.getElementsByTagName("parsererror").length) return undefined;
  const version = leafText(singleChild(project, "modelVersion"));
  // Maven 3 POM and Maven 4 build POM namespaces must match the model version.
  // https://maven.apache.org/pom.html
  // https://maven.apache.org/whatsnewinmaven4.html#model-version-410
  if (!version || !["4.0.0", "4.1.0"].includes(version)
    || (project.namespaceURI && project.namespaceURI !== `http://maven.apache.org/POM/${version}`)) return undefined;
  const artifactElements = children(project, "artifactId");
  const parent = singleChild(project, "parent");
  const artifact = artifactElements.length
    ? leafText(singleChild(project, "artifactId"))
    : parent && leafText(singleChild(parent, "artifactId"));
  if (!artifact || !/^[a-z0-9_.-]+$/i.test(artifact)) return undefined;
  return {
    manifestFormat: "maven",
    // A Maven lifecycle entry is known; neither an artifact path nor a successful
    // build is established by reading a POM.
    buildEntryKnown: true,
    // Compiler declarations: https://maven.apache.org/plugins/maven-compiler-plugin/examples/set-compiler-source-and-target.html
    runtimeRequirementKnown: javaRequirementDeclared(project),
  };
}

/**
 * Inspect complete file content only. Facts identify declarations for Skill
 * loading; they never prove installation, build success or artifact existence.
 * No file body, script, dependency URL or credential is returned.
 */
export function inspectProjectManifest(path: string, content: string): ManifestFacts | undefined {
  if (!content.trim() || path.includes("\0")) return undefined;
  const filename = path.split("/").pop();
  try {
    if (filename === "package.json") return inspectNpm(content);
    if (filename === "pom.xml") return inspectMaven(content);
  } catch {
    // Malformed or unsupported declarations retain the full-Skill fallback.
  }
  return undefined;
}
