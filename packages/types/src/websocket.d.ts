export interface WsOrderNew {
    event: 'order:new';
    data: {
        orderId: string;
        conceptId: string;
        source: string;
        stationIds: string[];
        placedAt: string;
    };
}
export interface WsOrderUpdated {
    event: 'order:updated';
    data: {
        orderId: string;
        status: string;
    };
}
export interface WsItemUpdated {
    event: 'item:updated';
    data: {
        itemId: string;
        status: string;
        stationId: string | null;
    };
}
export interface WsItem86d {
    event: 'item:86d';
    data: {
        menuItemId: string;
        conceptId: string;
        isAvailable: boolean;
    };
}
export interface WsKdsBump {
    event: 'kds:bump';
    data: {
        itemId: string;
    };
}
export interface WsKdsHold {
    event: 'kds:hold';
    data: {
        itemId: string;
    };
}
export interface WsKdsRecall {
    event: 'kds:recall';
    data: {
        itemId: string;
    };
}
export type ServerToClientEvents = WsOrderNew | WsOrderUpdated | WsItemUpdated | WsItem86d;
export type ClientToServerEvents = WsKdsBump | WsKdsHold | WsKdsRecall;
//# sourceMappingURL=websocket.d.ts.map