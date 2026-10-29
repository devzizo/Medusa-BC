import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { customerChanged, customerUpdate, mapCustomer } from "../src/lib/customers.js";

describe("mapCustomer", () => {
  it("splits a person's name and maps contact, address and BC identity", () => {
    const { body, address, issues } = mapCustomer({
      id: "c-1", number: "C0001", displayName: "عبدالعزيز محمد الحلوه", type: "Person",
      email: " Aziz@Example.com ", phoneNumber: "0500000000", blocked: "_x0020_",
      addressLine1: "شارع الملك فهد", city: "الرياض", country: "SA", postalCode: "12345", lastModifiedDateTime: "2026-10-01T00:00:00Z",
    });
    expect(issues).toEqual([]);
    expect(body).toEqual({
      email: "aziz@example.com", phone: "0500000000", first_name: "عبدالعزيز", last_name: "محمد الحلوه",
      metadata: { bc_customer_id: "c-1", bc_customer_number: "C0001", bc_type: "Person", bc_last_modified: "2026-10-01T00:00:00Z" },
    });
    expect(address).toMatchObject({ address_1: "شارع الملك فهد", city: "الرياض", country_code: "sa", postal_code: "12345", is_default_shipping: true });
  });

  it("keeps a company's name as the company, and reports an email Medusa would reject", () => {
    const { body, address, issues } = mapCustomer({ id: "c-2", number: "C0002", displayName: "شركة النخبة", type: "Company", email: "not-an-email", blocked: "All" });
    expect(body).toEqual({ company_name: "شركة النخبة", metadata: { bc_customer_id: "c-2", bc_customer_number: "C0002", bc_type: "Company", bc_blocked: "All" } });
    expect(address).toBe(null);
    expect(issues).toEqual([{ kind: "email", ref: "C0002", message: 'Email "not-an-email" is not valid; imported without it.' }]);
  });
});

describe("customerChanged", () => {
  const body = { email: "a@b.co", first_name: "Ali", metadata: { bc_customer_id: "c-1", bc_customer_number: "C1" } };
  it("is false when Medusa already holds what BC says, nulls and all", () => {
    expect(customerChanged(body, { email: "a@b.co", first_name: "Ali", last_name: null, phone: null, company_name: null, metadata: { bc_customer_id: "c-1", bc_customer_number: "C1", bc_blocked: "", other: 1 } })).toBe(false);
  });
  it("is true when a field or an owned metadata key moved", () => {
    expect(customerChanged(body, { email: "a@b.co", first_name: "Aly", metadata: body.metadata })).toBe(true);
    expect(customerChanged(body, { email: "a@b.co", first_name: "Ali", metadata: { ...body.metadata, bc_blocked: "All" } })).toBe(true);
  });
  it("updates every field and keeps metadata the sync does not own", () => {
    expect(customerUpdate(body, { metadata: { other: 1, bc_blocked: "All" } })).toEqual({
      email: "a@b.co", phone: null, first_name: "Ali", last_name: null, company_name: null,
      metadata: { other: 1, bc_customer_id: "c-1", bc_customer_number: "C1", bc_type: "", bc_blocked: "", bc_last_modified: "" },
    });
  });
});
