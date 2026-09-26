/*
 * -------------------------------------------------------
 * DATETIME TOOL
 * -------------------------------------------------------
 */

function getDatetime() {
    const now =
        new Date();


    return {
        utc:
            now.toISOString(),

        unix:
            Math.floor(
                now.getTime() /
                1000
            ),
    };
}


module.exports = {
    getDatetime,
};
