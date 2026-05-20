import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Highwood Emissions Management | Dashboard",
  description: "Monitoring dashboard for Highwood Emissions sites",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="border-b border-gray-200 bg-white shadow-sm">
          <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-semibold text-gray-900">Highwood Emissions Management</h1>
                <p className="text-xs text-gray-500">Monitoring Dashboard</p>
              </div>
              <nav className="flex gap-4 text-sm">
                <a href="/" className="font-medium text-gray-700 hover:text-gray-900">
                  Sites
                </a>
                <a href="/sites/new" className="font-medium text-gray-700 hover:text-gray-900">
                  New Site
                </a>
                <a href="/ingest" className="font-medium text-gray-700 hover:text-gray-900">
                  Ingest
                </a>
              </nav>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </body>
    </html>
  );
}
