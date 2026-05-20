import { CreateSiteForm } from "@/components/CreateSiteForm";

export const metadata = { title: "New Site | Highwood Emissions" };

export default function NewSitePage() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Create Site</h2>
        <p className="mt-1 text-sm text-gray-500">Register a new emissions monitoring site.</p>
      </div>
      <CreateSiteForm />
    </div>
  );
}
