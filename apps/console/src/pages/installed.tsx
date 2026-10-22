/** Installed skills for this account. */

import { useEffect, useState } from "react";
import { api, fmtDateTime } from "../lib/api";
import { Card, PageHead, Table, Td } from "../components/ui";
import { Link } from "react-router-dom";

interface InstalledRow {
  slug: string;
  at: string;
}

export function Installed() {
  const [rows, setRows] = useState<InstalledRow[] | null>(null);
  useEffect(() => {
    api
      .get<{ installs: InstalledRow[] }>("/api/me/installs")
      .then((r) => setRows(r.installs))
      .catch(() => setRows([]));
  }, []);
  return (
    <>
      <PageHead title="Installed" sub="Skills and packs this account installed from the marketplace." />
      {rows === null ? null : rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-navy/50">
          Nothing installed yet. The directory lives under{" "}
          <Link to="/marketplace" className="font-semibold text-navy underline">
            Marketplace → Skills directory
          </Link>
          .
        </Card>
      ) : (
        <Table head={["Skill", "Installed"]}>
          {rows.map((r) => (
            <tr key={`${r.slug}-${r.at}`}>
              <Td>
                <Link to={`/marketplace/${r.slug}`} className="font-semibold text-navy underline">
                  {r.slug}
                </Link>
              </Td>
              <Td>{fmtDateTime(r.at)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-navy/40">The member pack stays in Skills Hub and is not listed on the public directory.</p>
    </>
  );
}
