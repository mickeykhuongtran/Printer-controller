export type IconCategory =
    | "rfid"
    | "logistics"
    | "retail"
    | "editing"
    | "status"
    | "food"
    | "time"
    | "measurement"
    | "security"
    | "general";

export type IconDef = {
    id: string;
    name: string;
    keywords: string[];
    category: IconCategory;
    svg: string;
};

const SVG_OPEN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = "</svg>";
const stroke = (paths: string) => `${SVG_OPEN}${paths}${SVG_CLOSE}`;

export const ICON_LIBRARY: IconDef[] = [
    // ----- rfid -----
    {
        id: "rfid",
        name: "RFID",
        keywords: ["rfid", "tag", "wireless", "antenna", "uhf"],
        category: "rfid",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 511.02" fill="currentColor"><path d="M512,280.47v183.64c-4.23,23.9-23.02,42.79-47,46.91H47c-23.93-4.23-42.86-22.99-47-46.91V46.93C4.35,22.41,23.57,3.57,49.3.04l177.57.03c8.6,0,14.33,8.16,14.07,15.34-.28,7.84-6.39,14.54-15.04,14.54l-170.83.05c-13.99,0-25.08,11.08-25.08,25.07v400.93c0,13.24,10.52,25.03,24.19,25.03l402.64.04c14.06,0,25.14-11.04,25.14-25.02v-170.49c.01-8.59,5.29-14.99,13.52-15.97,7.21-.87,13.77,3.97,16.5,10.89Z"/><path d="M309,435.66c0,9.13-6.79,15.18-14.56,15.43-8.09.26-15.44-6.1-15.44-14.97v-119.67c0-8.56,6.85-14.75,14.53-14.98,8.12-.24,15.45,6.09,15.45,14.98l.02,119.21Z"/><path d="M385.44,450.55l-38.49.52c-8.33.11-15.15-6.36-15.16-14.95l-.2-120.23c-.01-7.75,6.9-14.4,14.26-14.4h36.19c24.52,0,45.26,14.56,54.73,37.35,10.03,24.13,9.89,52.07-1.07,75.88-9.3,20.2-27.64,34.59-50.26,35.83ZM408.66,402.23c7.47-17.55,7.07-36.88-.55-53.83-5.25-10.1-14.51-16.85-26.09-16.91l-20.42-.12.17,89.79,20.88-.38c11.65-.21,20.68-7.87,26.02-18.55Z"/><path d="M137.11,446.53l-38.96-43.94-.22,33.65c-.05,8.31-6.7,14.68-14.49,14.87s-15.44-6.08-15.44-14.98v-119.67c0-8.42,6.74-15.02,14.92-14.99l34.1.14c23.93.1,43.89,18.93,45.66,42.71,1.64,22.02-12.68,40.86-33.92,47.4l30.7,34.98c5.3,6.04,4.16,15.15-1.19,20.26-5.47,5.23-15.37,6.09-21.16-.43ZM132.75,347.82c.23-8.82-7.55-16.04-15.8-16.18l-18.88-.33.08,32.36,17.94-.15c8.31-.07,16.42-6.67,16.66-15.71Z"/><path d="M242.06,360.18c8.83,0,15.7,7.14,15.38,15.33-.35,8.9-7.42,14.76-16.38,14.72l-28.36-.12-.02,46.09c0,8.26-6.83,14.63-14.29,14.91-8.35.31-15.69-5.99-15.69-14.97v-119.65c0-8.68,6.88-15.03,15.26-15.03h48.06c8.59,0,14.97,6.48,15.24,14.51.26,7.59-5.72,15.3-14.25,15.33l-34.32.13-.03,28.73,29.38.03Z"/><path d="M511.58,208.76l.42,19.81c-2.82,6.9-9.07,11.71-16.58,10.88-7.1-.78-13.46-6.96-13.44-14.37.23-107.81-87.45-195.38-195.48-195.11-8.22.02-14.74-7.55-14.48-15.41.25-7.75,6.55-14.83,14.93-14.56l15.76.51c112.06,7.65,200.77,97.02,208.88,208.24Z"/><path d="M422.06,225.1c-.05-75-60.52-135.25-135.35-135.28-8.17,0-14.45-6.89-14.68-14.48-.25-8.12,6.22-15.35,14.59-15.39,91.32-.4,165.71,73.88,165.32,165.01-.03,7.99-6.7,14.33-14.5,14.54-7.31.2-15.38-5.37-15.38-14.41Z"/><path d="M331.98,224.58c0,24.79-20.14,44.89-44.98,44.89s-44.98-20.1-44.98-44.89,20.14-44.89,44.98-44.89,44.98,20.1,44.98,44.89ZM301.92,224.58c0-8.23-6.68-14.9-14.92-14.9s-14.92,6.67-14.92,14.9,6.68,14.9,14.92,14.9,14.92-6.67,14.92-14.9Z"/><path d="M362.1,225.04c-.28-42.03-33.55-75.1-75.19-75.34-8.39-.05-14.65-6.76-14.87-14.48-.24-8.1,6.12-15.37,14.82-15.39,58.13-.17,105.24,46.9,105.1,104.91-.02,8.32-6.73,14.54-14.5,14.78-7.47.23-15.3-5.4-15.36-14.47Z"/></svg>',
    },
    {
        id: "nfc",
        name: "NFC",
        keywords: ["nfc", "near-field", "wireless", "tap"],
        category: "rfid",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 746.15 549.98" fill="currentColor"><path d="M506.99,531.64c-90.67,25.3-186.37,24.34-275.93-2.37-88.31-26.34-175.27-83.77-213.19-169.87-24.42-55.46-23.78-117.75,1.7-172.77C62.4,94.15,160.59,36.38,257.49,13.45,371.65-13.56,500.57-.52,602.95,58.27c56.48,32.43,105.65,80.4,129.24,141.75,19.85,51.64,18.44,108.03-3.62,158.69-38.72,88.89-129.65,147.28-221.58,172.93ZM576.56,479.71c54.37-27.98,103.62-70.62,129.27-126.63,22.18-48.43,23.06-102.81,1.99-151.74-37.75-87.68-130.97-142.59-221.28-164.66-74.28-18.15-151.83-18.17-226.15-.2C174.77,57.19,88.11,106.69,45.76,185.71c-28.2,52.61-30.29,113.95-5.13,168.1,12.24,26.34,29.23,49.34,50.12,69.75,52.76,51.55,124.93,82.8,197.31,95.66,96.37,17.13,201.09,5.46,288.5-39.52Z"/><path d="M481.38,459.45c-4.75,9.16-16.73,11.13-24.78,6.81-9.09-4.89-12.55-15.79-7.78-25.38,39.21-78.82,52.75-162.27,31.08-248.57-7.18-28.6-17.11-55.42-30.37-81.61-5.14-10.14-3.05-21.75,7.22-27.19,9.78-5.18,21.3-.75,26.39,9.77,15.09,31.19,27.18,62.96,34.98,96.96,13.47,58.73,12.96,118.64-1.9,177.07-8.19,32.22-19.58,62.76-34.83,92.15Z"/><path d="M405.5,423.09c-5.43,9.47-17.25,11.35-25.42,6.52-8.69-5.14-12.06-16.18-6.93-25.47,46.67-84.31,44.71-173.33.07-258.11-5.1-9.69-1.97-20.82,7.28-25.96s21.07-1.42,26.22,8.59c37.46,72.91,50.26,150.82,26.21,230.33-6.82,22.54-15.55,43.4-27.43,64.1Z"/><path d="M327.35,385.95c-6.01,9.18-18.23,10.19-25.97,4.62-8.91-6.42-10.32-17.32-4.56-26.66,35.36-57.31,33.68-121.44-.54-178.91-5.62-9.43-2.92-20.75,5.97-26.26,9.56-5.92,21.26-2.29,26.8,7.5,11.84,20.92,20.94,42.23,26.27,65.85,8.61,38.13,5.99,76.97-7.82,113.46-5.41,14.3-11.63,27.37-20.16,40.4Z"/><path d="M254.38,348.9c-6.78,9.62-18.36,12.55-27.65,6.05-8.94-6.26-10.43-18.72-3.51-27.64,19.27-24.85,25.95-53.2,13.33-82.66-3.6-8.4-8.47-15.74-13.88-23.03-6.04-8.13-4.86-18.98,2.68-25.57,6.98-6.11,18.83-6.75,25.68,1.26,11.67,13.66,20.02,29.51,25.13,46.77,4.81,16.27,5.51,32.33,2.79,49.03-3.36,20.61-12.41,38.54-24.57,55.79Z"/></svg>',
    },
    {
        id: "nfc-alt",
        name: "NFC (Alt)",
        keywords: ["nfc", "near-field", "n", "tag", "alt", "alternative"],
        category: "rfid",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 899.99 900.04" fill="currentColor"><path d="M719.3,900.04H182.4c-98.49-3.07-178.28-81.99-182.4-180.4V180.35C4.09,82.34,83.33,3.54,181.35,0h538.31c97.94,4.08,176.85,83.35,180.33,181.35l-.02,538.33c-3.98,97.41-82.74,176.37-180.68,180.36ZM226.16,824.85c-27.29-34.61-38.95-75.68-38.95-118.57l.04-631.19c-59.96.09-111.78,48.56-111.84,109.15l-.48,531.49c2.28,59.94,50.23,107.88,110.2,109.12h41.03ZM703.05,825.05l-390.29-346.94,49.38-56.34,273.95,243.65c1.11.2,1.55.34,1.53.24l-.31-1.54V190.17c1.65-61.38-47.49-114.72-109.6-114.8l-330.76-.41,390.3,346.92-49.41,56.34-275.26-244.93.09,482.57c1.57,58.43,49.23,108.56,108.55,108.66l331.82.54ZM824.61,715.36l.44-531.09c-2.28-59.56-49.6-107.41-109.19-109.1l-42.1-.07c27.12,34.14,39.03,75.52,39.02,118.62l-.05,631.19c59.93,0,111.83-48.65,111.88-109.54Z"/></svg>',
    },
    {
        id: "antenna",
        name: "Antenna",
        keywords: ["antenna", "tower", "broadcast", "transmit"],
        category: "rfid",
        svg: stroke(
            '<path d="M2 12 7 2"/>' +
                '<path d="m7 12 5-10"/>' +
                '<path d="m12 12 5-10"/>' +
                '<path d="m17 12 5-10"/>' +
                '<path d="M4.5 7h15"/>' +
                '<path d="M12 16v6"/>',
        ),
    },
    {
        id: "signal",
        name: "Signal",
        keywords: ["signal", "bars", "reception", "strength"],
        category: "rfid",
        svg: stroke(
            '<path d="M3 20h.01"/>' +
                '<path d="M7 20v-4"/>' +
                '<path d="M12 20v-8"/>' +
                '<path d="M17 20v-12"/>' +
                '<path d="M21 20v-16"/>',
        ),
    },
    {
        id: "wifi",
        name: "Wi-Fi",
        keywords: ["wifi", "wireless", "internet", "network"],
        category: "rfid",
        svg: stroke(
            '<path d="M5 12.55a11 11 0 0 1 14 0"/>' +
                '<path d="M1.5 9a16 16 0 0 1 21 0"/>' +
                '<path d="M8.5 16.1a6 6 0 0 1 7 0"/>' +
                '<line x1="12" x2="12.01" y1="20" y2="20"/>',
        ),
    },
    {
        id: "tag",
        name: "Tag",
        keywords: ["tag", "label", "price", "marker"],
        category: "rfid",
        svg: stroke(
            '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/>' +
                '<circle cx="7.5" cy="7.5" r="1.25" fill="currentColor"/>',
        ),
    },
    {
        id: "scan",
        name: "Scan",
        keywords: ["scan", "scanner", "read", "barcode"],
        category: "rfid",
        svg: stroke(
            '<path d="M3 7V5a2 2 0 0 1 2-2h2"/>' +
                '<path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
                '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/>' +
                '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/>' +
                '<path d="M7 12h10"/>',
        ),
    },
    {
        id: "contactless",
        name: "Contactless",
        keywords: ["contactless", "tap", "pay", "wave"],
        category: "rfid",
        svg: stroke(
            '<path d="M5 7a8 8 0 0 1 0 10"/>' +
                '<path d="M9 9a5 5 0 0 1 0 6"/>' +
                '<path d="M13 11a2 2 0 0 1 0 2"/>' +
                '<path d="M17 12h.01"/>',
        ),
    },

    // ----- logistics -----
    {
        id: "package",
        name: "Package",
        keywords: ["package", "box", "parcel", "shipment"],
        category: "logistics",
        svg: stroke(
            '<path d="M16.5 9.4 7.55 4.24"/>' +
                '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
                '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/>' +
                '<line x1="12" x2="12" y1="22" y2="12"/>',
        ),
    },
    {
        id: "box",
        name: "Box",
        keywords: ["box", "carton", "container", "cube"],
        category: "logistics",
        svg: stroke(
            '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
                '<path d="m3.3 7 8.7 5 8.7-5"/>' +
                '<path d="M12 22V12"/>',
        ),
    },
    {
        id: "pallet",
        name: "Pallet",
        keywords: ["pallet", "skid", "warehouse", "stack"],
        category: "logistics",
        svg: stroke(
            '<rect x="3" y="6" width="18" height="3"/>' +
                '<rect x="3" y="11" width="18" height="3"/>' +
                '<path d="M3 17h18"/>' +
                '<path d="M5 17v3"/>' +
                '<path d="M9 17v3"/>' +
                '<path d="M15 17v3"/>' +
                '<path d="M19 17v3"/>',
        ),
    },
    {
        id: "truck",
        name: "Truck",
        keywords: ["truck", "delivery", "shipping", "vehicle"],
        category: "logistics",
        svg: stroke(
            '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>' +
                '<path d="M15 18H9"/>' +
                '<path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>' +
                '<circle cx="17" cy="18" r="2"/>' +
                '<circle cx="7" cy="18" r="2"/>',
        ),
    },
    {
        id: "container",
        name: "Container",
        keywords: ["container", "shipping", "freight", "cargo"],
        category: "logistics",
        svg: stroke(
            '<rect x="2" y="6" width="20" height="12" rx="1"/>' +
                '<line x1="6" y1="6" x2="6" y2="18"/>' +
                '<line x1="10" y1="6" x2="10" y2="18"/>' +
                '<line x1="14" y1="6" x2="14" y2="18"/>' +
                '<line x1="18" y1="6" x2="18" y2="18"/>',
        ),
    },
    {
        id: "warehouse",
        name: "Warehouse",
        keywords: ["warehouse", "storage", "depot", "facility"],
        category: "logistics",
        svg: stroke(
            '<path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/>' +
                '<path d="M6 18h12"/>' +
                '<path d="M6 14h12"/>' +
                '<path d="M6 10h12"/>',
        ),
    },
    {
        id: "fragile",
        name: "Fragile",
        keywords: ["fragile", "glass", "handle-with-care", "breakable"],
        category: "logistics",
        svg: stroke(
            '<path d="M8 4h8l-1 7a3 3 0 0 1-6 0z"/>' +
                '<path d="M12 14v6"/>' +
                '<path d="M9 20h6"/>',
        ),
    },
    {
        id: "this-side-up",
        name: "This Side Up",
        keywords: ["up", "orientation", "arrow", "shipping-mark"],
        category: "logistics",
        svg: stroke(
            '<rect x="4" y="9" width="16" height="11" rx="1"/>' +
                '<path d="M12 17V3"/>' +
                '<path d="m7 8 5-5 5 5"/>',
        ),
    },

    // ----- retail -----
    {
        id: "cart",
        name: "Cart",
        keywords: ["cart", "shopping", "trolley", "basket"],
        category: "retail",
        svg: stroke(
            '<circle cx="8" cy="21" r="1"/>' +
                '<circle cx="19" cy="21" r="1"/>' +
                '<path d="M2 3h2.5l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57L22 8H6"/>',
        ),
    },
    {
        id: "basket",
        name: "Basket",
        keywords: ["basket", "shopping", "groceries"],
        category: "retail",
        svg: stroke(
            '<path d="m5 11 4-7"/>' +
                '<path d="m19 11-4-7"/>' +
                '<path d="M2 11h20"/>' +
                '<path d="m3.5 11 1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.7-7.4"/>' +
                '<path d="m12 11-1 9"/>' +
                '<path d="m13 11 1 9"/>',
        ),
    },
    {
        id: "receipt",
        name: "Receipt",
        keywords: ["receipt", "invoice", "bill", "ticket"],
        category: "retail",
        svg: stroke(
            '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/>' +
                '<path d="M16 8H8"/>' +
                '<path d="M16 12H8"/>' +
                '<path d="M13 16H8"/>',
        ),
    },
    {
        id: "register",
        name: "Cash Register",
        keywords: ["register", "pos", "till", "cashier"],
        category: "retail",
        svg: stroke(
            '<rect x="3" y="10" width="18" height="11" rx="1"/>' +
                '<rect x="6" y="4" width="12" height="6" rx="1"/>' +
                '<circle cx="7" cy="14" r="0.6" fill="currentColor"/>' +
                '<circle cx="11" cy="14" r="0.6" fill="currentColor"/>' +
                '<circle cx="15" cy="14" r="0.6" fill="currentColor"/>' +
                '<path d="M7 18h10"/>',
        ),
    },
    {
        id: "price-tag",
        name: "Price Tag",
        keywords: ["price", "tag", "dollar", "sale"],
        category: "retail",
        svg: stroke(
            '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/>' +
                '<circle cx="7.5" cy="7.5" r="1.25" fill="currentColor"/>' +
                '<path d="M16 11.5c-.7-.5-1.7-.7-2.5-.2-1 .5-1 1.7 0 2.2l1.5.7c1 .5 1 1.7 0 2.2-.8.5-1.8.3-2.5-.2"/>' +
                '<path d="M14.25 10v8"/>',
        ),
    },
    {
        id: "store",
        name: "Store",
        keywords: ["store", "shop", "retail", "storefront"],
        category: "retail",
        svg: stroke(
            '<path d="m2 7 4-4h12l4 4"/>' +
                '<path d="M6 7v14"/>' +
                '<path d="M18 7v14"/>' +
                '<path d="M2 7v3a3 3 0 0 0 6 0M8 10a3 3 0 0 0 6 0M14 10a3 3 0 0 0 6 0"/>' +
                '<path d="M6 21h12"/>' +
                '<rect x="9" y="14" width="6" height="7"/>',
        ),
    },

    // ----- editing -----
    {
        id: "pencil",
        name: "Pencil",
        keywords: ["pencil", "edit", "write", "draw"],
        category: "editing",
        svg: stroke(
            '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>' +
                '<path d="m15 5 4 4"/>',
        ),
    },
    {
        id: "eraser",
        name: "Eraser",
        keywords: ["eraser", "rubber", "delete", "remove"],
        category: "editing",
        svg: stroke(
            '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>' +
                '<path d="M22 21H7"/>' +
                '<path d="m5 11 9 9"/>',
        ),
    },
    {
        id: "copy",
        name: "Copy",
        keywords: ["copy", "duplicate", "clone"],
        category: "editing",
        svg: stroke(
            '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
                '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        ),
    },
    {
        id: "scissors",
        name: "Scissors",
        keywords: ["scissors", "cut", "trim"],
        category: "editing",
        svg: stroke(
            '<circle cx="6" cy="6" r="3"/>' +
                '<path d="M8.12 8.12 12 12"/>' +
                '<path d="M20 4 8.12 15.88"/>' +
                '<circle cx="6" cy="18" r="3"/>' +
                '<path d="M14.8 14.8 20 20"/>',
        ),
    },
    {
        id: "paint",
        name: "Paint Bucket",
        keywords: ["paint", "bucket", "fill", "color"],
        category: "editing",
        svg: stroke(
            '<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0z"/>' +
                '<path d="m5 2 5 5"/>' +
                '<path d="M2 13h15"/>' +
                '<path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z"/>',
        ),
    },

    // ----- status -----
    {
        id: "check",
        name: "Check",
        keywords: ["check", "tick", "ok", "done", "approved"],
        category: "status",
        svg: stroke('<path d="M20 6 9 17l-5-5"/>'),
    },
    {
        id: "x-mark",
        name: "X Mark",
        keywords: ["x", "close", "reject", "cancel", "denied"],
        category: "status",
        svg: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    },
    {
        id: "warning",
        name: "Warning",
        keywords: ["warning", "alert", "caution", "triangle"],
        category: "status",
        svg: stroke(
            '<path d="M21.73 18 13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>' +
                '<path d="M12 9v4"/>' +
                '<path d="M12 17h.01"/>',
        ),
    },
    {
        id: "info",
        name: "Info",
        keywords: ["info", "information", "help", "i"],
        category: "status",
        svg: stroke(
            '<circle cx="12" cy="12" r="10"/>' +
                '<path d="M12 16v-4"/>' +
                '<path d="M12 8h.01"/>',
        ),
    },
    {
        id: "error",
        name: "Error",
        keywords: ["error", "alert", "circle", "exclamation"],
        category: "status",
        svg: stroke(
            '<circle cx="12" cy="12" r="10"/>' +
                '<line x1="12" x2="12" y1="8" y2="12"/>' +
                '<line x1="12" x2="12.01" y1="16" y2="16"/>',
        ),
    },
    {
        id: "prohibited",
        name: "Prohibited",
        keywords: ["prohibited", "forbidden", "no", "ban"],
        category: "status",
        svg: stroke(
            '<circle cx="12" cy="12" r="10"/>' +
                '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
        ),
    },
    {
        id: "hop-chuan",
        name: "Hợp Chuẩn",
        keywords: ["hop chuan", "certified", "standard", "compliance", "approved", "tcvn", "vietnamese"],
        category: "status",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 237 211.99" fill="currentColor"><path d="M102,0l.39,32c-21.14,3.08-39.2,12.99-52.22,29.06-20.56,25.38-21.37,60.55-1.91,86.76,13.03,17.33,31.79,28.42,54.07,31.51l.1,31.95c-24.98-2.42-47.39-11.89-65.81-27.85C16.96,166.11,3.93,143.27.98,117.05l-.98-5.05.27-12.94C5.07,45.52,47.42,6.51,100,0h2Z"/><path d="M127.95.35c29.31,3.54,56.66,17.65,75.71,40.85,27.79,33.67,31.4,80.6,7.94,117.82l-25.07-23.67c10.45-22.45,8.36-47.11-4.4-67.51-12.98-19.85-33.33-32.57-57.13-35.84V0s2.95.35,2.95.35Z"/><polygon points="237 211.99 188.98 211.99 159.11 184.28 158.97 211.01 124.12 211 124.29 105.17 234.51 208.28 237 211.99"/></svg>',
    },

    // ----- food -----
    {
        id: "snowflake",
        name: "Snowflake",
        keywords: ["snowflake", "cold", "frozen", "freeze", "winter"],
        category: "food",
        svg: stroke(
            '<line x1="2" x2="22" y1="12" y2="12"/>' +
                '<line x1="12" x2="12" y1="2" y2="22"/>' +
                '<path d="m20 16-4-4 4-4"/>' +
                '<path d="m4 8 4 4-4 4"/>' +
                '<path d="m16 4-4 4-4-4"/>' +
                '<path d="m8 20 4-4 4 4"/>',
        ),
    },
    {
        id: "flame",
        name: "Flame",
        keywords: ["flame", "fire", "hot", "heat"],
        category: "food",
        svg: stroke(
            '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
        ),
    },
    {
        id: "leaf",
        name: "Leaf",
        keywords: ["leaf", "eco", "natural", "organic", "plant"],
        category: "food",
        svg: stroke(
            '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.8.66c0 1.65-.79 6.83-3.61 9.94S11 21 11 20Z"/>' +
                '<path d="M2 21c0-3 1.85-5.36 5.08-6"/>',
        ),
    },
    {
        id: "bottle",
        name: "Bottle",
        keywords: ["bottle", "drink", "liquid", "beverage"],
        category: "food",
        svg: stroke(
            '<path d="M10 2h4"/>' +
                '<path d="M10 2v4l-2 2v12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V8l-2-2V2"/>' +
                '<path d="M8 14h8"/>',
        ),
    },
    {
        id: "apple",
        name: "Apple",
        keywords: ["apple", "fruit", "food", "fresh"],
        category: "food",
        svg: stroke(
            '<path d="M14 4c0-1 1-2 2-2"/>' +
                '<path d="M12 6c-3 0-6 2-6 7s3 9 6 9 6-4 6-9-3-7-6-7Z"/>',
        ),
    },

    // ----- time -----
    {
        id: "calendar",
        name: "Calendar",
        keywords: ["calendar", "date", "schedule", "day"],
        category: "time",
        svg: stroke(
            '<rect width="18" height="18" x="3" y="4" rx="2"/>' +
                '<path d="M16 2v4"/>' +
                '<path d="M8 2v4"/>' +
                '<path d="M3 10h18"/>',
        ),
    },
    {
        id: "clock",
        name: "Clock",
        keywords: ["clock", "time", "watch", "hour"],
        category: "time",
        svg: stroke(
            '<circle cx="12" cy="12" r="10"/>' +
                '<polyline points="12 6 12 12 16 14"/>',
        ),
    },
    {
        id: "hourglass",
        name: "Hourglass",
        keywords: ["hourglass", "timer", "wait", "sand"],
        category: "time",
        svg: stroke(
            '<path d="M5 22h14"/>' +
                '<path d="M5 2h14"/>' +
                '<path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/>' +
                '<path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
        ),
    },
    {
        id: "expiry",
        name: "Expiry",
        keywords: ["expiry", "expired", "use-by", "date"],
        category: "time",
        svg: stroke(
            '<rect width="18" height="18" x="3" y="4" rx="2"/>' +
                '<path d="M16 2v4"/>' +
                '<path d="M8 2v4"/>' +
                '<path d="M3 10h18"/>' +
                '<path d="m9.5 14 5 5"/>' +
                '<path d="m14.5 14-5 5"/>',
        ),
    },

    // ----- measurement -----
    {
        id: "scale",
        name: "Scale",
        keywords: ["scale", "balance", "weight", "measure"],
        category: "measurement",
        svg: stroke(
            '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/>' +
                '<path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/>' +
                '<path d="M7 21h10"/>' +
                '<path d="M12 3v18"/>' +
                '<path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
        ),
    },
    {
        id: "weight",
        name: "Weight",
        keywords: ["weight", "kettlebell", "kilogram", "mass"],
        category: "measurement",
        svg: stroke(
            '<circle cx="12" cy="5" r="3"/>' +
                '<path d="M6.5 8h11l1.4 12c.05.5-.3 1-.97 1H6.07c-.66 0-1.02-.5-.97-1Z"/>',
        ),
    },
    {
        id: "ruler",
        name: "Ruler",
        keywords: ["ruler", "measure", "length", "dimension"],
        category: "measurement",
        svg: stroke(
            '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/>' +
                '<path d="m14.5 12.5 2-2"/>' +
                '<path d="m11.5 9.5 2-2"/>' +
                '<path d="m8.5 6.5 2-2"/>' +
                '<path d="m17.5 15.5 2-2"/>',
        ),
    },
    {
        id: "thermometer",
        name: "Thermometer",
        keywords: ["thermometer", "temperature", "heat", "celsius"],
        category: "measurement",
        svg: stroke(
            '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
        ),
    },

    // ----- security -----
    {
        id: "lock",
        name: "Lock",
        keywords: ["lock", "secure", "padlock", "closed"],
        category: "security",
        svg: stroke(
            '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
                '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        ),
    },
    {
        id: "unlock",
        name: "Unlock",
        keywords: ["unlock", "open", "padlock"],
        category: "security",
        svg: stroke(
            '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
                '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
        ),
    },
    {
        id: "shield",
        name: "Shield",
        keywords: ["shield", "protect", "security", "guard"],
        category: "security",
        svg: stroke(
            '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
        ),
    },
    {
        id: "key",
        name: "Key",
        keywords: ["key", "unlock", "access", "credential"],
        category: "security",
        svg: stroke(
            '<path d="m21 2-9.6 9.6"/>' +
                '<circle cx="7.5" cy="15.5" r="5.5"/>' +
                '<path d="m15.5 7.5 3 3"/>' +
                '<path d="m20 12-2-2"/>',
        ),
    },

    // ----- general -----
    {
        id: "star",
        name: "Star",
        keywords: ["star", "favorite", "rating"],
        category: "general",
        svg: stroke(
            '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
        ),
    },
    {
        id: "heart",
        name: "Heart",
        keywords: ["heart", "love", "favorite", "like"],
        category: "general",
        svg: stroke(
            '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
        ),
    },
    {
        id: "bookmark",
        name: "Bookmark",
        keywords: ["bookmark", "save", "marker"],
        category: "general",
        svg: stroke(
            '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
        ),
    },
    {
        id: "location-pin",
        name: "Location Pin",
        keywords: ["location", "pin", "map", "marker", "place"],
        category: "general",
        svg: stroke(
            '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/>' +
                '<circle cx="12" cy="10" r="3"/>',
        ),
    },
    {
        id: "recycle",
        name: "Recycle",
        keywords: ["recycle", "recycling", "bin", "trash", "waste", "eco", "delete"],
        category: "general",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 386.11 511.22" fill="currentColor"><defs><style>.cls-1{fill:#fff;}</style></defs><path d="M271.16.07c24.04,2.86,41.31,23.87,39.57,47.81s-21.35,41.58-44.97,41.41c-23.84-.17-43.57-19-44.43-43.21S237.66,2.81,261.12,0l10.04.07Z"/><polygon points="311.87 338.65 215.83 511.22 252.52 236.02 386.11 232.6 357.96 504.81 311.87 338.65"/><polygon points="254.88 230.58 235.78 153.2 52.19 97.24 322.13 92.5 384.95 223.81 254.88 230.58"/><polygon points="162.03 214.79 97.67 219.47 48.69 205.92 56.51 139.64 105.17 164.39 170.98 164.31 162.03 214.79"/><path d="M178.73,505.93c-41.19-4.79-82.11-5.42-124.51.23l-33.5-235.33-12.36-.71c-5.46-.31-8.04-6.77-8.32-10.98-.34-5.12,1.89-11.09,7.47-13.4h217.99c5.05,2.01,7.34,7.28,7.49,11.52.18,4.88-1.48,10.69-7.03,12.53-3.63,1.2-8.64.76-13.74.63l-33.49,235.51ZM66.31,290.7l-1.47-20.19-27.92.02,3.34,22.66,26.05-2.5ZM108.48,288.77l-.08-18.25h-27.41s1.33,19.31,1.33,19.31l26.16-1.06ZM150.77,289.85l1.3-19.34-27.51.13.02,18.23,26.18.97ZM192.94,293.07l3.17-22.57-27.97.04-1.34,20.25,26.14,2.28ZM108.49,328.57l-.02-23.55-24.97.76,1.65,23.18,23.34-.39ZM147.95,328.89l1.58-23.11-25.01-.72.12,23.59,23.3.25ZM69.17,330.11l-1.68-23.29-25,2.32,3.37,23.23,23.3-2.26ZM187.38,332.28l3.27-23.15-25-2.24-1.62,23.37,23.35,2.03ZM108.47,367.65v-23.1s-22.15.59-22.15.59l1.67,23.25,20.48-.73ZM145.18,368.42l1.63-23.3-22.09-.55v23.1s20.46.75,20.46.75ZM71.94,369.49l-1.74-23.17-22.11,1.9,3.16,22.99,20.69-1.72ZM181.79,371.19l3.38-22.95-22.2-1.93-1.69,23.17,20.5,1.71ZM108.46,407.07l-.08-23.33-19.36.75,1.72,23.24,17.72-.67ZM142.4,407.69l1.61-23.16-19.36-.8-.11,23.36,17.86.59ZM74.64,408.61l-1.68-23.2-19.4,1.75,3.28,23.15,17.8-1.71ZM176.28,410.18l3.1-23.12-19.31-1.62-1.61,23.26,17.82,1.48ZM108.45,446.64l.04-23.39-16.64.52,1.62,23.15,14.97-.29ZM139.69,446.77l1.52-22.99-16.41-.6-.14,23.5,15.02.09ZM77.46,447.9l-1.75-23.34-16.61,1.59,3.29,23.16,15.06-1.41ZM170.67,449.22l3.3-23.11-16.77-1.48-1.39,23.47,14.85,1.12ZM108.5,485.74l-.05-23.14-13.77.58,1.65,23.14,12.17-.57ZM136.87,486.17l1.5-23.03-13.7-.51.02,23.28,12.17.26ZM80.25,487.07l-1.69-22.96-13.88,1.21,3.26,23,12.31-1.24ZM165.17,488.19l3.24-22.91-13.82-1.13-1.71,23.04,12.29.99Z"/><polygon class="cls-1" points="192.94 293.07 166.81 290.8 168.14 270.55 196.11 270.51 192.94 293.07"/><polygon class="cls-1" points="66.31 290.7 40.25 293.2 36.91 270.54 64.84 270.52 66.31 290.7"/><polygon class="cls-1" points="108.49 328.57 85.14 328.96 83.49 305.78 108.46 305.02 108.49 328.57"/><polygon class="cls-1" points="69.17 330.11 45.87 332.37 42.5 309.14 67.5 306.82 69.17 330.11"/><polygon class="cls-1" points="187.38 332.28 164.03 330.25 165.66 306.88 190.65 309.12 187.38 332.28"/><polygon class="cls-1" points="147.95 328.89 124.65 328.64 124.52 305.05 149.53 305.78 147.95 328.89"/><polygon class="cls-1" points="150.77 289.85 124.58 288.88 124.56 270.64 152.07 270.51 150.77 289.85"/><polygon class="cls-1" points="108.48 288.77 82.32 289.84 80.99 270.53 108.4 270.53 108.48 288.77"/><polygon class="cls-1" points="108.47 367.65 87.98 368.39 86.31 345.14 108.45 344.55 108.47 367.65"/><polygon class="cls-1" points="71.94 369.49 51.25 371.21 48.09 348.22 70.19 346.32 71.94 369.49"/><polygon class="cls-1" points="181.79 371.19 161.29 369.48 162.97 346.32 185.17 348.25 181.79 371.19"/><polygon class="cls-1" points="145.18 368.42 124.71 367.67 124.72 344.57 146.81 345.12 145.18 368.42"/><polygon class="cls-1" points="108.46 407.07 90.74 407.74 89.02 384.5 108.38 383.75 108.46 407.07"/><polygon class="cls-1" points="142.4 407.69 124.54 407.09 124.64 383.73 144.01 384.53 142.4 407.69"/><polygon class="cls-1" points="74.64 408.61 56.84 410.32 53.56 387.17 72.96 385.41 74.64 408.61"/><polygon class="cls-1" points="176.28 410.18 158.46 408.7 160.07 385.44 179.38 387.06 176.28 410.18"/><polygon class="cls-1" points="108.45 446.64 93.48 446.93 91.86 423.77 108.49 423.25 108.45 446.64"/><polygon class="cls-1" points="170.67 449.22 155.82 448.1 157.2 424.63 173.97 426.11 170.67 449.22"/><polygon class="cls-1" points="77.46 447.9 62.4 449.31 59.11 426.15 75.71 424.56 77.46 447.9"/><polygon class="cls-1" points="139.69 446.77 124.67 446.68 124.81 423.18 141.22 423.78 139.69 446.77"/><polygon class="cls-1" points="108.5 485.74 96.32 486.31 94.68 463.18 108.45 462.6 108.5 485.74"/><polygon class="cls-1" points="80.25 487.07 67.94 488.32 64.69 465.32 78.57 464.11 80.25 487.07"/><polygon class="cls-1" points="165.17 488.19 152.89 487.2 154.59 464.16 168.42 465.28 165.17 488.19"/><polygon class="cls-1" points="136.87 486.17 124.7 485.91 124.68 462.64 138.38 463.14 136.87 486.17"/></svg>',
    },
];
