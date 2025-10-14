using Neo4j.Driver;
using System;
using System.Threading.Tasks;

namespace Neo4jTest
{
    class Neo4jConnectionTest
    {
        private static readonly string Neo4jUri = "neo4j+s://b8cac1b8.databases.neo4j.io";
        private static readonly string Neo4jUser = "neo4j";
        private static readonly string Neo4jPassword = "WdvWJgEOcboJyssTvyivZnr5RdrinwioDyu4NUZvhvI";

        static async Task Main()
        {
            try
            {
                using var driver = GraphDatabase.Driver(Neo4jUri, AuthTokens.Basic(Neo4jUser, Neo4jPassword));
                await driver.VerifyConnectivityAsync();
                Console.WriteLine("Successfully connected to Neo4j Aura DB!");

                var session = driver.AsyncSession();
                try
                {
                    var result = await session.RunAsync("RETURN 'Hello, Neo4j!' AS message");
                    var record = await result.SingleAsync();
                    Console.WriteLine($"Query result: {record["message"].As<string>()}");
                }
                finally
                {
                    await session.CloseAsync();
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Connection failed: {ex.Message}");
            }
        }
    }
}