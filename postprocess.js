const DATA_FILE = "./councillors.json";
const COUNCILLOR_IMAGE_DIRECTORY = "./images/councillors";
const PARTY_IMAGE_DIRECTORY = "./images/parties";

const MAX_CONCURRENT_DOWNLOADS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

await Deno.mkdir(COUNCILLOR_IMAGE_DIRECTORY, { recursive: true });
await Deno.mkdir(PARTY_IMAGE_DIRECTORY, { recursive: true });

const rawData = await Deno.readTextFile(DATA_FILE);
const councillors = JSON.parse(rawData);

if (!Array.isArray(councillors)) {
  throw new Error(`${DATA_FILE} must contain a JSON array.`);
}

/**
 * Produces a safe and stable filename.
 */
function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate that a remote image URL is from the expected CMIS host.
 *
 * This prevents the script becoming an unrestricted downloader if the
 * source data is compromised or unexpectedly changed.
 */
function validateRemoteImageUrl(value) {
  if (!value) {
    return null;
  }

  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error(`Image URL must use HTTPS: ${value}`);
  }

  if (url.hostname.toLowerCase() !== "cmis.hullcc.gov.uk") {
    throw new Error(`Unexpected image host: ${url.hostname}`);
  }

  return url;
}

/**
 * Choose a suitable file extension from the response Content-Type.
 *
 * Party-logo endpoints do not necessarily include an extension in their URL.
 */
function getExtension(contentType, sourceUrl) {
  const normalisedContentType = contentType
    ?.split(";")[0]
    ?.trim()
    ?.toLowerCase();

  const extensionByContentType = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  };

  if (extensionByContentType[normalisedContentType]) {
    return extensionByContentType[normalisedContentType];
  }

  const pathname = new URL(sourceUrl).pathname.toLowerCase();
  const pathnameMatch = pathname.match(/\.(jpg|jpeg|png|webp|gif|svg)$/);

  if (pathnameMatch) {
    return pathnameMatch[1] === "jpeg"
      ? ".jpg"
      : `.${pathnameMatch[1]}`;
  }

  throw new Error(
    `Could not determine image format for ${sourceUrl}. ` +
      `Received Content-Type: ${contentType ?? "none"}`,
  );
}

/**
 * Download an image to a stable basename.
 *
 * Returns the final repository-relative path, including the detected
 * extension.
 */
async function downloadImage(sourceUrl, directory, basename) {
  const validatedUrl = validateRemoteImageUrl(sourceUrl);

  if (!validatedUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(validatedUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*",
        "User-Agent": "Hull-City-Council-Councillor-Data/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Image request failed with HTTP ${response.status}: ${sourceUrl}`,
      );
    }

    const contentType = response.headers.get("content-type");
    const extension = getExtension(contentType, sourceUrl);

    if (!contentType?.toLowerCase().startsWith("image/")) {
      throw new Error(
        `Expected an image from ${sourceUrl}, but received ` +
          `${contentType ?? "an unknown content type"}.`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    // Prevent accidentally committing an HTML error page or an excessively
    // large response. Adjust if legitimate images exceed this limit.
    const maximumBytes = 5 * 1024 * 1024;

    if (bytes.length === 0) {
      throw new Error(`Empty image returned by ${sourceUrl}`);
    }

    if (bytes.length > maximumBytes) {
      throw new Error(
        `Image exceeds the 5 MB limit: ${sourceUrl}`,
      );
    }

    const filename = `${basename}${extension}`;
    const filesystemPath = `${directory}/${filename}`;

    await removeOtherExtensions(directory, basename, extension);
    await Deno.writeFile(filesystemPath, bytes);

    return filesystemPath.replace(/^\.\//, "");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * If CMIS changes an image from JPG to PNG, remove the old version.
 */
async function removeOtherExtensions(directory, basename, keepExtension) {
  const knownExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".svg",
  ];

  for (const extension of knownExtensions) {
    if (extension === keepExtension) {
      continue;
    }

    try {
      await Deno.remove(`${directory}/${basename}${extension}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}

/**
 * Extract a stable party identifier from a CMIS party-logo URL.
 *
 * Example:
 * /id/3/LogoSize/...
 * becomes:
 * 3
 */
function getPartyId(partyLogoUrl) {
  if (!partyLogoUrl) {
    return null;
  }

  const match = new URL(partyLogoUrl).pathname.match(/\/id\/(\d+)(?:\/|$)/i);
  return match?.[1] ?? null;
}

/**
 * Run asynchronous operations in limited-size batches so CMIS is not hit
 * with every request simultaneously.
 */
async function processInBatches(items, batchSize, callback) {
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    await Promise.all(batch.map(callback));
  }
}

const partyDownloads = new Map();

await processInBatches(
  councillors,
  MAX_CONCURRENT_DOWNLOADS,
  async (councillor) => {
    if (!councillor.id) {
      throw new Error(
        `Councillor is missing an id: ${JSON.stringify(councillor)}`,
      );
    }

    /*
     * Download the councillor photograph using the stable CMIS councillor ID.
     *
     * Result:
     * images/councillors/1173.jpg
     */
    if (councillor.photoUrl) {
      try {
        const localPhotoPath = await downloadImage(
          councillor.photoUrl,
          COUNCILLOR_IMAGE_DIRECTORY,
          String(councillor.id),
        );

        councillor.photoUrl = localPhotoPath;
      } catch (error) {
        console.error(
          `Could not download photo for councillor ${councillor.id}:`,
          error,
        );

        // Do not retain the external CMIS URL in the published data.
        councillor.photoUrl = null;
      }
    }

    /*
     * Download each political party logo once.
     *
     * The same Promise is reused when multiple councillors belong to the
     * same party.
     */
    if (councillor.partyLogoUrl) {
      const partyId = getPartyId(councillor.partyLogoUrl);
      const partyName = slugify(councillor.party || "unknown-party");
      const partyBasename = partyId
        ? `${partyId}-${partyName}`
        : partyName;

      const partyKey = partyId ?? councillor.partyLogoUrl;

      if (!partyDownloads.has(partyKey)) {
        partyDownloads.set(
          partyKey,
          downloadImage(
            councillor.partyLogoUrl,
            PARTY_IMAGE_DIRECTORY,
            partyBasename,
          ).catch((error) => {
            console.error(
              `Could not download logo for ${councillor.party}:`,
              error,
            );

            return null;
          }),
        );
      }

      councillor.partyLogoUrl = await partyDownloads.get(partyKey);
    }
  },
);

await Deno.writeTextFile(
  DATA_FILE,
  `${JSON.stringify(councillors, null, 2)}\n`,
);

console.log(
  `Processed ${councillors.length} councillors and ` +
    `${partyDownloads.size} party logos.`,
);