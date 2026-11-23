import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage } from "@vercel/geistdocs/pages/docs";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { config } from "@/lib/geistdocs/config";
import { versionedOgImage } from "@/lib/geistdocs/og-version";
import { geistdocsSource, getPageImage } from "@/lib/geistdocs/source";

const docsPage = createDocsPage({
  config,
  mdx: ({ link }) => getMDXComponents({ a: link }),
  metadata: ({ metadata, page }) => {
    // The version is derived from the card's title so a content change busts
    // the social cache for that card.
    const images = [
      {
        url: versionedOgImage(getPageImage(page).url, page.data.title ?? ""),
        width: 1200,
        height: 630,
        alt: "screen-relay",
      },
    ];

    return {
      ...metadata,
      openGraph: {
        ...metadata.openGraph,
        images,
      },
      twitter: {
        card: "summary_large_image",
        title: metadata.title ?? undefined,
        description: metadata.description ?? undefined,
        images,
      },
    };
  },
  openGraph: {
    images: true,
  },
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
