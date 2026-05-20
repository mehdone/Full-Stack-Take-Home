import { Controller, Get, Header } from "@nestjs/common";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { RawResponse } from "../common/envelope/raw-response.decorator.ts";
import { buildOpenApiDocument } from "./openapi.builder.ts";

const REDOC_HTML = `<!doctype html>
<html>
  <head>
    <title>Highwood Emissions API — Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet" />
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url="/openapi.json"></redoc>
    <script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>
`;

@Controller()
export class DocsController {
  @Get("openapi.json")
  @RawResponse()
  @Header("Content-Type", "application/json; charset=utf-8")
  @Header("Cache-Control", "public, max-age=60")
  getSpec(): OpenAPIObject {
    return buildOpenApiDocument();
  }

  @Get("docs")
  @RawResponse()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "public, max-age=300")
  getDocs(): string {
    return REDOC_HTML;
  }
}
