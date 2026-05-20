import type { ComplianceStatus } from "@highwood/contracts";

interface Props {
  status: ComplianceStatus;
}

export function ComplianceBadge({ status }: Props) {
  if (status === "compliant") {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
        Within Limit
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
      Limit Exceeded
    </span>
  );
}
