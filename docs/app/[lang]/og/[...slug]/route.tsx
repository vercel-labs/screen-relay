import type { NextRequest } from "next/server";
import { getPageImage, source } from "@/lib/geistdocs/source";
import { renderLabsOg } from "./labs-og";

const product = "screen-relay";

// Used for the OG card only; the site's own title metadata is unchanged.
const homeTitle = "Stream and control desktops from a browser";

export const GET = async (
  _request: NextRequest,
  { params }: RouteContext<"/[lang]/og/[...slug]">
) => {
  const { slug, lang } = await params;
  const page = source.getPage(slug.slice(0, -1), lang);

  if (!page) {
    return new Response("Not found", { status: 404 });
  }

  // The docs index is the home card, which leads with the home headline.
  const title =
    page.slugs.length === 0 ? homeTitle : (page.data.title ?? product);

  return renderLabsOg({ product, title });
};

export const generateStaticParams = async ({
  params,
}: RouteContext<"/[lang]/og/[...slug]">) => {
  const { lang } = await params;

  return source.getPages(lang).map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
};
